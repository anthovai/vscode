import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type {
  CreateLocalKinguProfileResult,
  KinguProfileAuthStatus,
  KinguProfileListResult,
  TransferKinguProfileProjectResult
} from '../../../../shared/kingu-profiles'

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

const listState: KinguProfileListResult = {
  activeProfileId: 'local-default',
  multiProfileUi: false,
  profiles: [
    {
      id: 'local-default',
      name: 'Personal',
      avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
      kind: 'local',
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1
    }
  ]
}

const createdState: CreateLocalKinguProfileResult = {
  activeProfileId: 'local-default',
  profiles: [
    ...listState.profiles,
    {
      id: 'local-work',
      name: 'Work',
      avatar: { kind: 'initials', initials: 'W', color: 'neutral' },
      kind: 'local',
      createdAt: 2,
      updatedAt: 2,
      lastOpenedAt: 2
    }
  ],
  profile: {
    id: 'local-work',
    name: 'Work',
    avatar: { kind: 'initials', initials: 'W', color: 'neutral' },
    kind: 'local',
    createdAt: 2,
    updatedAt: 2,
    lastOpenedAt: 2
  }
}

const localAuthStatus: KinguProfileAuthStatus = {
  activeProfileId: 'local-default',
  configured: false,
  state: 'unconfigured',
  persistence: 'none'
}

const connectedAuthStatus: KinguProfileAuthStatus = {
  activeProfileId: 'local-default',
  configured: true,
  state: 'connected',
  persistence: 'encrypted',
  cloud: {
    cloudProfileId: 'cloud-profile-1',
    userId: 'user-1',
    email: 'nina@example.com',
    linkedAt: 3
  },
  capabilities: {
    flags: { share: true },
    refreshedAt: 4
  }
}

const kinguProfilesApi = {
  list: vi.fn(),
  authStatus: vi.fn(),
  createLocal: vi.fn(),
  createCloudLinked: vi.fn(),
  connectCurrent: vi.fn(),
  refreshAuth: vi.fn(),
  signOutCurrent: vi.fn(),
  selectOrg: vi.fn(),
  switchProfile: vi.fn(),
  transferProject: vi.fn()
}

describe('kingu profile slice', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    toastErrorMock.mockReset()
    kinguProfilesApi.authStatus.mockResolvedValue(localAuthStatus)
    vi.stubGlobal('window', {
      api: {
        kinguProfiles: kinguProfilesApi
      }
    })
  })

  it('fetches profiles into store state', async () => {
    kinguProfilesApi.list.mockResolvedValue(listState)
    const store = createTestStore()

    await store.getState().fetchKinguProfiles()

    expect(store.getState().activeKinguProfileId).toBe('local-default')
    expect(store.getState().kinguProfiles).toEqual(listState.profiles)
    expect(store.getState().kinguProfileAuthStatus).toEqual(localAuthStatus)
    expect(store.getState().kinguProfilesMultiProfileUi).toBe(false)
    expect(store.getState().kinguProfilesLoading).toBe(false)
  })

  it('stores the multi-profile UI flag from the list result', async () => {
    kinguProfilesApi.list.mockResolvedValue({ ...listState, multiProfileUi: true })
    const store = createTestStore()

    await store.getState().fetchKinguProfiles()

    expect(store.getState().kinguProfilesMultiProfileUi).toBe(true)
  })

  it('creates a local profile and returns the created summary', async () => {
    kinguProfilesApi.createLocal.mockResolvedValue(createdState)
    const store = createTestStore()

    const profile = await store.getState().createLocalKinguProfile('Work')

    expect(profile).toEqual(createdState.profile)
    expect(kinguProfilesApi.createLocal).toHaveBeenCalledWith({ name: 'Work' })
    expect(store.getState().kinguProfiles).toEqual(createdState.profiles)
  })

  it('fetches auth status independently', async () => {
    kinguProfilesApi.authStatus.mockResolvedValue(connectedAuthStatus)
    const store = createTestStore()

    await expect(store.getState().fetchKinguProfileAuthStatus()).resolves.toEqual(
      connectedAuthStatus
    )
    expect(store.getState().kinguProfileAuthStatus).toEqual(connectedAuthStatus)
  })

  it('sets switching state while requesting a profile switch', async () => {
    kinguProfilesApi.switchProfile.mockResolvedValue({ status: 'relaunching' })
    const store = createTestStore()
    store.setState({ activeKinguProfileId: 'local-default' })

    const result = await store.getState().switchKinguProfile('local-work')

    expect(result).toEqual({ status: 'relaunching' })
    expect(kinguProfilesApi.switchProfile).toHaveBeenCalledWith({ profileId: 'local-work' })
    expect(store.getState().kinguProfileSwitching).toBe(true)
  })

  it('releases switching state when main reports the profile is already active', async () => {
    // Why: a stale renderer activeKinguProfileId must not lock the switcher
    // forever when no relaunch is actually coming.
    kinguProfilesApi.switchProfile.mockResolvedValue({ status: 'already-active' })
    const store = createTestStore()
    store.setState({ activeKinguProfileId: 'local-default' })

    const result = await store.getState().switchKinguProfile('local-work')

    expect(result).toEqual({ status: 'already-active' })
    expect(store.getState().kinguProfileSwitching).toBe(false)
  })

  it('does not call main when switching to the active profile', async () => {
    const store = createTestStore()
    store.setState({ activeKinguProfileId: 'local-default' })

    const result = await store.getState().switchKinguProfile('local-default')

    expect(result).toEqual({ status: 'already-active' })
    expect(kinguProfilesApi.switchProfile).not.toHaveBeenCalled()
  })

  it('transfers projects through the profile API', async () => {
    const transferResult: TransferKinguProfileProjectResult = {
      status: 'transferred',
      mode: 'copy',
      sourceProfileId: 'local-default',
      targetProfileId: 'local-work',
      sourceRepoId: 'repo-1',
      targetRepoId: 'repo-2',
      targetProjectId: 'repo:repo-2'
    }
    kinguProfilesApi.transferProject.mockResolvedValue(transferResult)
    const store = createTestStore()

    const result = await store.getState().transferKinguProfileProject({
      sourceProfileId: 'local-default',
      targetProfileId: 'local-work',
      repoId: 'repo-1',
      mode: 'copy'
    })

    expect(result).toEqual(transferResult)
    expect(kinguProfilesApi.transferProject).toHaveBeenCalledWith({
      sourceProfileId: 'local-default',
      targetProfileId: 'local-work',
      repoId: 'repo-1',
      mode: 'copy'
    })
  })

  it('marks profile switching when a project transfer relaunches the app', async () => {
    const transferResult: TransferKinguProfileProjectResult = {
      status: 'transferred',
      mode: 'move',
      sourceProfileId: 'local-default',
      targetProfileId: 'local-work',
      sourceRepoId: 'repo-1',
      targetRepoId: 'repo-1',
      targetProjectId: 'repo:repo-1',
      willRelaunch: true
    }
    kinguProfilesApi.transferProject.mockResolvedValue(transferResult)
    const store = createTestStore()

    await store.getState().transferKinguProfileProject({
      sourceProfileId: 'local-default',
      targetProfileId: 'local-work',
      repoId: 'repo-1',
      mode: 'move'
    })

    expect(store.getState().kinguProfileSwitching).toBe(true)
  })

  it('warns when a project already exists in the target profile', async () => {
    const transferResult: TransferKinguProfileProjectResult = {
      status: 'duplicate-target',
      sourceProfileId: 'local-default',
      targetProfileId: 'local-work',
      sourceRepoId: 'repo-1',
      duplicateRepoId: 'repo-existing'
    }
    kinguProfilesApi.transferProject.mockResolvedValue(transferResult)
    const store = createTestStore()

    await store.getState().transferKinguProfileProject({
      sourceProfileId: 'local-default',
      targetProfileId: 'local-work',
      repoId: 'repo-1',
      mode: 'copy'
    })

    expect(toastErrorMock).toHaveBeenCalledWith('Project already exists in that profile')
    expect(store.getState().kinguProfileSwitching).toBe(false)
  })
})
