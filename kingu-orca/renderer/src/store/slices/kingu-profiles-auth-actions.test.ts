import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ConnectCurrentKinguProfileResult,
  CreateCloudLinkedKinguProfileResult,
  KinguProfileAuthStatus,
  KinguProfileListState,
  RefreshCurrentKinguProfileAuthResult,
  SelectKinguProfileOrgResult,
  SignOutCurrentKinguProfileResult
} from '../../../../shared/kingu-profiles'
import { createTestStore } from './store-test-helpers'

const { toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    info: vi.fn(),
    success: toastSuccessMock,
    warning: vi.fn()
  }
}))

const listState: KinguProfileListState = {
  activeProfileId: 'local-default',
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

const localAuthStatus: KinguProfileAuthStatus = {
  activeProfileId: 'local-default',
  configured: false,
  state: 'unconfigured',
  persistence: 'none'
}

const connectedCloud = {
  cloudProfileId: 'cloud-profile-1',
  userId: 'user-1',
  email: 'nina@example.com',
  linkedAt: 3
}

const connectedOrganizations = [
  { orgId: 'org-1', name: 'Acme', role: 'Admin' },
  { orgId: 'org-2', name: 'Personal' }
]

const connectedAuthStatus: KinguProfileAuthStatus = {
  activeProfileId: 'local-default',
  configured: true,
  state: 'connected',
  persistence: 'encrypted',
  cloud: connectedCloud,
  organizations: connectedOrganizations,
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

describe('kingu profile auth actions slice', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    toastErrorMock.mockReset()
    toastSuccessMock.mockReset()
    kinguProfilesApi.authStatus.mockResolvedValue(localAuthStatus)
    vi.stubGlobal('window', {
      api: {
        kinguProfiles: kinguProfilesApi
      }
    })
  })

  it('connects the current profile and stores returned cloud metadata', async () => {
    const connectedProfiles = [
      {
        ...listState.profiles[0],
        kind: 'cloud-linked' as const,
        cloud: connectedAuthStatus.cloud
      }
    ]
    const result: ConnectCurrentKinguProfileResult = {
      status: 'connected',
      auth: connectedAuthStatus,
      activeProfileId: 'local-default',
      profiles: connectedProfiles
    }
    kinguProfilesApi.connectCurrent.mockResolvedValue(result)
    const store = createTestStore()

    await expect(store.getState().connectCurrentKinguProfile()).resolves.toEqual(result)
    expect(store.getState().kinguProfileAuthStatus).toEqual(connectedAuthStatus)
    expect(store.getState().kinguProfiles).toEqual(connectedProfiles)
    expect(toastSuccessMock).toHaveBeenCalledOnce()
  })

  it('starts a second sign-in while the first browser wait is still open', async () => {
    const connectedProfiles = [
      {
        ...listState.profiles[0],
        kind: 'cloud-linked' as const,
        cloud: connectedAuthStatus.cloud
      }
    ]
    const connected: ConnectCurrentKinguProfileResult = {
      status: 'connected',
      auth: connectedAuthStatus,
      activeProfileId: 'local-default',
      profiles: connectedProfiles
    }
    const cancelled: ConnectCurrentKinguProfileResult = {
      status: 'cancelled',
      auth: connectedAuthStatus
    }
    let finishFirst!: (value: ConnectCurrentKinguProfileResult) => void
    kinguProfilesApi.connectCurrent
      .mockReturnValueOnce(
        new Promise<ConnectCurrentKinguProfileResult>((resolve) => {
          finishFirst = resolve
        })
      )
      .mockResolvedValueOnce(connected)
    const store = createTestStore()

    const first = store.getState().connectCurrentKinguProfile()
    const second = store.getState().connectCurrentKinguProfile()

    expect(kinguProfilesApi.connectCurrent).toHaveBeenCalledTimes(2)
    await expect(second).resolves.toEqual(connected)
    expect(toastSuccessMock).toHaveBeenCalledOnce()
    finishFirst(cancelled)
    await expect(first).resolves.toEqual(cancelled)
    expect(toastErrorMock).not.toHaveBeenCalled()
    expect(toastSuccessMock).toHaveBeenCalledOnce()
    expect(store.getState().kinguProfileAuthStatus).toEqual(connectedAuthStatus)
  })

  it('refreshes current profile auth and stores fresh capability flags', async () => {
    const refreshedAuthStatus: KinguProfileAuthStatus = {
      ...connectedAuthStatus,
      capabilities: {
        flags: { share: false, team: true },
        refreshedAt: 8
      }
    }
    const result: RefreshCurrentKinguProfileAuthResult = {
      status: 'refreshed',
      auth: refreshedAuthStatus,
      activeProfileId: 'local-default',
      profiles: [
        {
          ...listState.profiles[0],
          kind: 'cloud-linked',
          cloud: refreshedAuthStatus.cloud
        }
      ]
    }
    kinguProfilesApi.refreshAuth.mockResolvedValue(result)
    const store = createTestStore()

    await expect(store.getState().refreshCurrentKinguProfileAuth()).resolves.toEqual(result)
    expect(kinguProfilesApi.refreshAuth).toHaveBeenCalledOnce()
    expect(store.getState().kinguProfileAuthStatus).toEqual(refreshedAuthStatus)
    expect(store.getState().kinguProfiles).toEqual(result.profiles)
  })

  it('creates a cloud-linked profile and stores the returned profile list', async () => {
    const cloudProfile = {
      id: 'cloud-acme',
      name: 'Acme',
      avatar: { kind: 'initials' as const, initials: 'A', color: 'neutral' as const },
      kind: 'cloud-linked' as const,
      createdAt: 5,
      updatedAt: 5,
      lastOpenedAt: 5,
      cloud: {
        ...connectedCloud,
        cloudProfileId: 'cloud-profile-2',
        activeOrgId: 'org-1',
        activeOrgName: 'Acme'
      }
    }
    const result: CreateCloudLinkedKinguProfileResult = {
      status: 'created',
      auth: connectedAuthStatus,
      activeProfileId: 'local-default',
      profiles: [...listState.profiles, cloudProfile],
      profile: cloudProfile
    }
    kinguProfilesApi.createCloudLinked.mockResolvedValue(result)
    const store = createTestStore()

    await expect(
      store.getState().createCloudLinkedKinguProfile({ orgId: 'org-1', name: 'Acme' })
    ).resolves.toEqual(result)
    expect(kinguProfilesApi.createCloudLinked).toHaveBeenCalledWith({
      orgId: 'org-1',
      name: 'Acme'
    })
    expect(store.getState().kinguProfiles).toEqual(result.profiles)
  })

  it('signs out the current profile without dropping local profile data', async () => {
    const result: SignOutCurrentKinguProfileResult = {
      status: 'signed-out',
      auth: localAuthStatus,
      activeProfileId: 'local-default',
      profiles: listState.profiles
    }
    kinguProfilesApi.signOutCurrent.mockResolvedValue(result)
    const store = createTestStore()

    await expect(store.getState().signOutCurrentKinguProfile()).resolves.toEqual(result)
    expect(store.getState().kinguProfileAuthStatus).toEqual(localAuthStatus)
    expect(store.getState().kinguProfiles).toEqual(listState.profiles)
  })

  it('selects a cloud organization and refreshes auth state', async () => {
    const selectedAuthStatus: KinguProfileAuthStatus = {
      ...connectedAuthStatus,
      cloud: {
        ...connectedCloud,
        activeOrgId: 'org-1',
        activeOrgName: 'Acme'
      }
    }
    const result: SelectKinguProfileOrgResult = {
      status: 'selected',
      auth: selectedAuthStatus,
      activeProfileId: 'local-default',
      profiles: [
        {
          ...listState.profiles[0],
          kind: 'cloud-linked',
          cloud: selectedAuthStatus.cloud
        }
      ]
    }
    kinguProfilesApi.selectOrg.mockResolvedValue(result)
    const store = createTestStore()

    await expect(store.getState().selectKinguProfileOrg('org-1')).resolves.toEqual(result)
    expect(kinguProfilesApi.selectOrg).toHaveBeenCalledWith({ orgId: 'org-1' })
    expect(store.getState().kinguProfileAuthStatus).toEqual(selectedAuthStatus)
    expect(store.getState().kinguProfileAuthStatus?.organizations).toEqual(connectedOrganizations)
  })
})
