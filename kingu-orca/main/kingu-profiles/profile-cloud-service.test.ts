import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  KinguCloudCapabilities,
  KinguCloudOrgSummary,
  KinguProfileCloudSummary
} from '../../shared/kingu-profiles'
import type { KinguCloudSessionExchangeResponse } from './profile-cloud-session-exchange'

const {
  beginKinguCloudPkceFlowMock,
  createKinguCloudProfileMock,
  exchangeKinguCloudAuthCodeMock,
  revokeKinguCloudSessionMock,
  selectKinguCloudOrgMock,
  safeStorageMock
} = vi.hoisted(() => ({
  beginKinguCloudPkceFlowMock: vi.fn(),
  createKinguCloudProfileMock: vi.fn(),
  exchangeKinguCloudAuthCodeMock: vi.fn(),
  revokeKinguCloudSessionMock: vi.fn(),
  selectKinguCloudOrgMock: vi.fn(),
  safeStorageMock: {
    decryptString: vi.fn((value: Buffer) => value.toString('utf-8')),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf-8')),
    isEncryptionAvailable: vi.fn(() => true)
  }
}))

let userDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  },
  safeStorage: safeStorageMock
}))

vi.mock('./profile-cloud-pkce', () => ({
  beginKinguCloudPkceFlow: beginKinguCloudPkceFlowMock
}))

vi.mock('./profile-cloud-client', () => ({
  createKinguCloudProfile: createKinguCloudProfileMock,
  exchangeKinguCloudAuthCode: exchangeKinguCloudAuthCodeMock,
  revokeKinguCloudSession: revokeKinguCloudSessionMock,
  selectKinguCloudOrg: selectKinguCloudOrgMock
}))

import {
  connectCurrentKinguProfile,
  createCloudLinkedKinguProfile,
  getCurrentKinguProfileAuthStatus,
  selectCurrentKinguProfileOrg,
  signOutCurrentKinguProfile
} from './profile-cloud-service'

const cloudSummary: KinguProfileCloudSummary = {
  cloudProfileId: 'cloud-profile-1',
  userId: 'user-1',
  email: 'nina@example.com',
  displayName: 'Nina',
  linkedAt: 10
}

const capabilities: KinguCloudCapabilities = {
  flags: { share: true },
  refreshedAt: 11
}

const organizations: KinguCloudOrgSummary[] = [
  { orgId: 'org-1', name: 'Acme', role: 'Admin' },
  { orgId: 'org-2', name: 'Personal' }
]

function configureCloudEnv(): void {
  vi.stubEnv('KINGU_CLOUD_API_URL', 'https://kingu-cloud.example')
  vi.stubEnv('KINGU_CLOUD_CLIENT_ID', 'desktop-client')
}

function futureExpiresAt(): number {
  return Date.now() + 3_600_000
}

function mockSuccessfulConnect(expiresAt = futureExpiresAt()): void {
  beginKinguCloudPkceFlowMock.mockResolvedValue({
    code: 'auth-code',
    codeVerifier: 'code-verifier',
    nonce: 'nonce',
    redirectUri: 'http://127.0.0.1:4100/auth/callback',
    state: 'state'
  })
  exchangeKinguCloudAuthCodeMock.mockResolvedValue({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt,
    cloud: cloudSummary,
    organizations,
    capabilities
  } satisfies KinguCloudSessionExchangeResponse)
}

describe('Kingu cloud profile service', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'kingu-cloud-service-'))
    beginKinguCloudPkceFlowMock.mockReset()
    createKinguCloudProfileMock.mockReset()
    exchangeKinguCloudAuthCodeMock.mockReset()
    revokeKinguCloudSessionMock.mockReset()
    selectKinguCloudOrgMock.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf-8'))
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value, 'utf-8'))
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    revokeKinguCloudSessionMock.mockResolvedValue(undefined)
    vi.unstubAllEnvs()
    vi.stubEnv('KINGU_CLOUD_API_URL', '')
    vi.stubEnv('KINGU_CLOUD_CLIENT_ID', '')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('reports local unconfigured auth without cloud setup', () => {
    expect(getCurrentKinguProfileAuthStatus(userDataPath)).toMatchObject({
      activeProfileId: 'local-default',
      configured: false,
      state: 'unconfigured',
      persistence: 'none'
    })
  })

  it('connects the active local profile without replacing its local profile ID', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()

    const result = await connectCurrentKinguProfile(userDataPath)

    if (result.status !== 'connected') {
      throw new Error(`Expected connected result, got ${result.status}`)
    }
    expect(result.activeProfileId).toBe('local-default')
    expect(result.profiles[0]).toMatchObject({
      id: 'local-default',
      kind: 'cloud-linked',
      cloud: cloudSummary
    })
    expect(exchangeKinguCloudAuthCodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ localProfileId: 'local-default', nonce: 'nonce' })
    )
    expect(getCurrentKinguProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'connected',
      persistence: 'encrypted',
      cloud: cloudSummary,
      organizations,
      capabilities
    })
  })

  it('treats provider-denied sign-in as a cancelled connect attempt', async () => {
    configureCloudEnv()
    beginKinguCloudPkceFlowMock.mockRejectedValue(new Error('kingu_cloud_auth_denied'))

    const result = await connectCurrentKinguProfile(userDataPath)

    expect(result.status).toBe('cancelled')
    expect(exchangeKinguCloudAuthCodeMock).not.toHaveBeenCalled()
    expect(getCurrentKinguProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'local',
      persistence: 'none'
    })
  })

  it('reports callback failures as failed instead of cancelled', async () => {
    configureCloudEnv()
    beginKinguCloudPkceFlowMock.mockRejectedValue(new Error('kingu_cloud_auth_callback_failed'))

    const result = await connectCurrentKinguProfile(userDataPath)

    expect(result).toMatchObject({ status: 'failed', error: 'kingu_cloud_auth_callback_failed' })
    expect(exchangeKinguCloudAuthCodeMock).not.toHaveBeenCalled()
    expect(getCurrentKinguProfileAuthStatus(userDataPath)).toMatchObject({ state: 'local' })
  })

  it('does not report a saved cloud session as connected when cloud config is unavailable', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    await connectCurrentKinguProfile(userDataPath)
    vi.stubEnv('KINGU_CLOUD_API_URL', '')
    vi.stubEnv('KINGU_CLOUD_CLIENT_ID', '')

    expect(getCurrentKinguProfileAuthStatus(userDataPath)).toMatchObject({
      configured: false,
      state: 'unconfigured',
      persistence: 'encrypted',
      cloud: cloudSummary,
      setupMessage: 'Kingu Cloud sign-in is not configured for this build.'
    })
    expect(getCurrentKinguProfileAuthStatus(userDataPath).organizations).toBeUndefined()
    expect(getCurrentKinguProfileAuthStatus(userDataPath).capabilities).toBeUndefined()
  })

  it('signs out by removing cloud metadata while keeping the local profile', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    await connectCurrentKinguProfile(userDataPath)

    const result = await signOutCurrentKinguProfile(userDataPath)

    expect(result.status).toBe('signed-out')
    expect(result.activeProfileId).toBe('local-default')
    expect(result.profiles[0]).toMatchObject({ id: 'local-default', kind: 'local' })
    expect(result.profiles[0]?.cloud).toBeUndefined()
    expect(getCurrentKinguProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'local',
      persistence: 'none'
    })
    expect(revokeKinguCloudSessionMock).toHaveBeenCalledOnce()
  })

  it('creates a new empty cloud-linked profile with its own cloud session', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    await connectCurrentKinguProfile(userDataPath)
    createKinguCloudProfileMock.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresAt: 1000,
      cloud: {
        ...cloudSummary,
        cloudProfileId: 'cloud-profile-2',
        activeOrgId: 'org-1',
        activeOrgName: 'Acme'
      },
      organizations,
      capabilities: { flags: { share: true, team: true }, refreshedAt: 13 }
    } satisfies KinguCloudSessionExchangeResponse)

    const result = await createCloudLinkedKinguProfile(userDataPath, {
      orgId: 'org-1',
      name: 'Acme'
    })

    if (result.status !== 'created') {
      throw new Error(`Expected created result, got ${result.status}`)
    }
    expect(result.profile).toMatchObject({
      id: expect.stringMatching(/^cloud-/),
      name: 'Acme',
      kind: 'cloud-linked',
      cloud: expect.objectContaining({ cloudProfileId: 'cloud-profile-2' })
    })
    expect(createKinguCloudProfileMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ accessToken: 'access-token' }),
      { orgId: 'org-1', name: 'Acme' }
    )
  })

  it('selects an organization for a connected profile', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    await connectCurrentKinguProfile(userDataPath)
    const orgCloudSummary = {
      ...cloudSummary,
      activeOrgId: 'org-1',
      activeOrgName: 'Acme'
    }
    selectKinguCloudOrgMock.mockResolvedValue({
      cloud: orgCloudSummary,
      organizations,
      capabilities: { flags: { share: true, sso: true }, refreshedAt: 12 }
    })

    const result = await selectCurrentKinguProfileOrg(userDataPath, 'org-1')

    expect(result.status).toBe('selected')
    expect(selectKinguCloudOrgMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ accessToken: 'access-token' }),
      'org-1'
    )
    expect(getCurrentKinguProfileAuthStatus(userDataPath).cloud).toMatchObject({
      activeOrgId: 'org-1',
      activeOrgName: 'Acme'
    })
    expect(getCurrentKinguProfileAuthStatus(userDataPath).organizations).toEqual(organizations)
  })
})
