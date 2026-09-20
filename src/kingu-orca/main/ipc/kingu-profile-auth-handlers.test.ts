import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  createCloudLinkedKinguProfileMock,
  connectCurrentKinguProfileMock,
  getCurrentKinguProfileAuthStatusMock,
  refreshCurrentKinguProfileAuthMock,
  selectCurrentKinguProfileOrgMock,
  signOutCurrentKinguProfileMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  createCloudLinkedKinguProfileMock: vi.fn(),
  connectCurrentKinguProfileMock: vi.fn(),
  getCurrentKinguProfileAuthStatusMock: vi.fn(),
  refreshCurrentKinguProfileAuthMock: vi.fn(),
  selectCurrentKinguProfileOrgMock: vi.fn(),
  signOutCurrentKinguProfileMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    exit: vi.fn(),
    relaunch: vi.fn()
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('../tray/system-tray', () => ({
  destroySystemTray: vi.fn()
}))

vi.mock('../kingu-profiles/profile-index-store', () => ({
  createLocalKinguProfile: vi.fn(),
  getKinguProfileListState: vi.fn(),
  seedNewKinguProfileTelemetryConsent: vi.fn(),
  setActiveKinguProfile: vi.fn()
}))

vi.mock('../kingu-profiles/profile-project-transfer', () => ({
  transferKinguProfileProject: vi.fn()
}))

vi.mock('../kingu-profiles/profile-cloud-service', () => ({
  createCloudLinkedKinguProfile: createCloudLinkedKinguProfileMock,
  connectCurrentKinguProfile: connectCurrentKinguProfileMock,
  getCurrentKinguProfileAuthStatus: getCurrentKinguProfileAuthStatusMock,
  refreshCurrentKinguProfileAuth: refreshCurrentKinguProfileAuthMock,
  selectCurrentKinguProfileOrg: selectCurrentKinguProfileOrgMock,
  signOutCurrentKinguProfile: signOutCurrentKinguProfileMock
}))

import { registerKinguProfileHandlers } from './kingu-profiles'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

describe('registerKinguProfileHandlers auth channels', () => {
  beforeEach(() => {
    // Why the port and per-test: userData resolves through AppEnvironment now, and
    // the global setup's beforeEach reinstates its own fake before this runs.
    installFakeAppEnvironment({ getPath: () => '/tmp/kingu-user-data' })
    handlers.clear()
    createCloudLinkedKinguProfileMock.mockReset()
    connectCurrentKinguProfileMock.mockReset()
    getCurrentKinguProfileAuthStatusMock.mockReset()
    refreshCurrentKinguProfileAuthMock.mockReset()
    selectCurrentKinguProfileOrgMock.mockReset()
    signOutCurrentKinguProfileMock.mockReset()
  })

  it('returns auth status for the current profile', async () => {
    const status = {
      activeProfileId: 'local-default',
      configured: false,
      state: 'unconfigured',
      persistence: 'none'
    }
    getCurrentKinguProfileAuthStatusMock.mockReturnValue(status)
    registerKinguProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(Promise.resolve(handlers.get('kinguProfiles:authStatus')?.(null))).resolves.toBe(
      status
    )
    expect(getCurrentKinguProfileAuthStatusMock).toHaveBeenCalledWith('/tmp/kingu-user-data')
  })

  it('connects and signs out the current profile through the cloud service', async () => {
    const connectResult = { status: 'unconfigured', auth: { activeProfileId: 'local-default' } }
    const signOutResult = { status: 'signed-out', auth: { activeProfileId: 'local-default' } }
    connectCurrentKinguProfileMock.mockResolvedValue(connectResult)
    signOutCurrentKinguProfileMock.mockResolvedValue(signOutResult)
    registerKinguProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(
      Promise.resolve(handlers.get('kinguProfiles:connectCurrent')?.(null))
    ).resolves.toBe(connectResult)
    await expect(
      Promise.resolve(handlers.get('kinguProfiles:signOutCurrent')?.(null))
    ).resolves.toBe(signOutResult)
    expect(connectCurrentKinguProfileMock).toHaveBeenCalledWith('/tmp/kingu-user-data')
    expect(signOutCurrentKinguProfileMock).toHaveBeenCalledWith('/tmp/kingu-user-data')
  })

  it('refreshes profile auth through the cloud service', async () => {
    const refreshResult = { status: 'refreshed', auth: { activeProfileId: 'local-default' } }
    refreshCurrentKinguProfileAuthMock.mockResolvedValue(refreshResult)
    registerKinguProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(Promise.resolve(handlers.get('kinguProfiles:refreshAuth')?.(null))).resolves.toBe(
      refreshResult
    )
    expect(refreshCurrentKinguProfileAuthMock).toHaveBeenCalledWith('/tmp/kingu-user-data')
  })

  it('validates organization selection before calling the cloud service', async () => {
    const selectResult = { status: 'selected', auth: { activeProfileId: 'local-default' } }
    selectCurrentKinguProfileOrgMock.mockResolvedValue(selectResult)
    registerKinguProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(
      Promise.resolve(handlers.get('kinguProfiles:selectOrg')?.(null, { orgId: ' org-1 ' }))
    ).resolves.toBe(selectResult)
    expect(selectCurrentKinguProfileOrgMock).toHaveBeenCalledWith('/tmp/kingu-user-data', 'org-1')

    await expect(
      Promise.resolve(handlers.get('kinguProfiles:selectOrg')?.(null, { orgId: ' ' }))
    ).rejects.toThrow('invalid_kingu_profile_org_selection')
  })

  it('creates cloud-linked profiles with trimmed optional args', async () => {
    const createResult = {
      status: 'created',
      auth: { activeProfileId: 'local-default' },
      activeProfileId: 'local-default',
      profiles: [],
      profile: { id: 'cloud-1' }
    }
    createCloudLinkedKinguProfileMock.mockResolvedValue(createResult)
    registerKinguProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(
      Promise.resolve(
        handlers.get('kinguProfiles:createCloudLinked')?.(null, {
          orgId: ' org-1 ',
          name: ' Acme '
        })
      )
    ).resolves.toBe(createResult)
    expect(createCloudLinkedKinguProfileMock).toHaveBeenCalledWith('/tmp/kingu-user-data', {
      orgId: 'org-1',
      name: 'Acme'
    })
  })
})
