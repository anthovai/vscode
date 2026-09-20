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
  refreshKinguCloudCapabilitiesMock,
  refreshKinguCloudSessionMock,
  selectKinguCloudOrgMock,
  KinguCloudRequestErrorMock,
  safeStorageMock
} = vi.hoisted(() => ({
  beginKinguCloudPkceFlowMock: vi.fn(),
  createKinguCloudProfileMock: vi.fn(),
  exchangeKinguCloudAuthCodeMock: vi.fn(),
  refreshKinguCloudCapabilitiesMock: vi.fn(),
  refreshKinguCloudSessionMock: vi.fn(),
  selectKinguCloudOrgMock: vi.fn(),
  KinguCloudRequestErrorMock: class KinguCloudRequestError extends Error {
    constructor(public readonly statusCode: number) {
      super(`kingu_cloud_request_failed_${statusCode}`)
      this.name = 'KinguCloudRequestError'
    }
  },
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
  KinguCloudRequestError: KinguCloudRequestErrorMock,
  isAmbiguousCloudRequestFailure: (error: unknown) =>
    !(error instanceof KinguCloudRequestErrorMock),
  createKinguCloudProfile: createKinguCloudProfileMock,
  exchangeKinguCloudAuthCode: exchangeKinguCloudAuthCodeMock,
  refreshKinguCloudCapabilities: refreshKinguCloudCapabilitiesMock,
  refreshKinguCloudSession: refreshKinguCloudSessionMock,
  revokeKinguCloudSession: vi.fn(),
  selectKinguCloudOrg: selectKinguCloudOrgMock
}))

import {
  connectCurrentKinguProfile,
  createCloudLinkedKinguProfile,
  getCurrentKinguProfileAuthStatus,
  refreshCurrentKinguProfileAuth,
  selectCurrentKinguProfileOrg
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

function futureExpiresAt(): number {
  return Date.now() + 3_600_000
}

function configureCloudEnv(): void {
  vi.stubEnv('KINGU_CLOUD_API_URL', 'https://kingu-cloud.example')
  vi.stubEnv('KINGU_CLOUD_CLIENT_ID', 'desktop-client')
}

function mockSuccessfulConnect(): void {
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
    expiresAt: futureExpiresAt(),
    cloud: cloudSummary,
    organizations,
    capabilities
  } satisfies KinguCloudSessionExchangeResponse)
}

function mockSuccessfulSessionRefresh(): void {
  refreshKinguCloudSessionMock.mockResolvedValue({
    accessToken: 'rotated-access-token',
    refreshToken: 'rotated-refresh-token',
    expiresAt: futureExpiresAt(),
    cloud: cloudSummary,
    organizations,
    capabilities
  } satisfies KinguCloudSessionExchangeResponse)
}

describe('Kingu cloud profile auth-failure retry', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'kingu-cloud-service-auth-retry-'))
    beginKinguCloudPkceFlowMock.mockReset()
    createKinguCloudProfileMock.mockReset()
    exchangeKinguCloudAuthCodeMock.mockReset()
    refreshKinguCloudCapabilitiesMock.mockReset()
    refreshKinguCloudSessionMock.mockReset()
    selectKinguCloudOrgMock.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf-8'))
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value, 'utf-8'))
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    vi.unstubAllEnvs()
    vi.stubEnv('KINGU_CLOUD_API_URL', '')
    vi.stubEnv('KINGU_CLOUD_CLIENT_ID', '')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('refreshes and retries cloud profile creation after an auth failure', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    mockSuccessfulSessionRefresh()
    await connectCurrentKinguProfile(userDataPath)
    createKinguCloudProfileMock
      .mockRejectedValueOnce(new KinguCloudRequestErrorMock(401))
      .mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: futureExpiresAt(),
        cloud: { ...cloudSummary, cloudProfileId: 'cloud-profile-2' },
        organizations,
        capabilities
      } satisfies KinguCloudSessionExchangeResponse)

    const result = await createCloudLinkedKinguProfile(userDataPath, { name: 'Acme' })

    expect(result.status).toBe('created')
    expect(createKinguCloudProfileMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({ accessToken: 'rotated-access-token' }),
      { name: 'Acme' }
    )
  })

  it('refreshes and retries capability refresh after an auth failure', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    mockSuccessfulSessionRefresh()
    await connectCurrentKinguProfile(userDataPath)
    refreshKinguCloudCapabilitiesMock
      .mockRejectedValueOnce(new KinguCloudRequestErrorMock(403))
      .mockResolvedValue({
        capabilities: { flags: { share: false }, refreshedAt: 26 } satisfies KinguCloudCapabilities
      })

    const result = await refreshCurrentKinguProfileAuth(userDataPath)

    expect(result.status).toBe('refreshed')
    expect(refreshKinguCloudCapabilitiesMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({ accessToken: 'rotated-access-token' })
    )
    expect(getCurrentKinguProfileAuthStatus(userDataPath).capabilities).toEqual({
      flags: { share: false },
      refreshedAt: 26
    })
  })

  it('requires reconnect when a retried capability refresh is still unauthorized', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    mockSuccessfulSessionRefresh()
    await connectCurrentKinguProfile(userDataPath)
    refreshKinguCloudCapabilitiesMock
      .mockRejectedValueOnce(new KinguCloudRequestErrorMock(401))
      .mockRejectedValueOnce(new KinguCloudRequestErrorMock(401))

    const result = await refreshCurrentKinguProfileAuth(userDataPath)

    expect(result.status).toBe('reconnect-required')
    expect(getCurrentKinguProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'reconnect-required',
      persistence: 'none',
      cloud: cloudSummary
    })
  })

  it('refreshes and retries organization selection after an auth failure', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    mockSuccessfulSessionRefresh()
    await connectCurrentKinguProfile(userDataPath)
    selectKinguCloudOrgMock
      .mockRejectedValueOnce(new KinguCloudRequestErrorMock(401))
      .mockResolvedValue({
        cloud: { ...cloudSummary, activeOrgId: 'org-1', activeOrgName: 'Acme' },
        organizations,
        capabilities
      })

    const result = await selectCurrentKinguProfileOrg(userDataPath, 'org-1')

    expect(result.status).toBe('selected')
    expect(selectKinguCloudOrgMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({ accessToken: 'rotated-access-token' }),
      'org-1'
    )
  })
})
