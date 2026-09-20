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
  KinguCloudRequestErrorMock,
  safeStorageMock
} = vi.hoisted(() => ({
  beginKinguCloudPkceFlowMock: vi.fn(),
  createKinguCloudProfileMock: vi.fn(),
  exchangeKinguCloudAuthCodeMock: vi.fn(),
  refreshKinguCloudCapabilitiesMock: vi.fn(),
  refreshKinguCloudSessionMock: vi.fn(),
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
  selectKinguCloudOrg: vi.fn()
}))

import {
  connectCurrentKinguProfile,
  createCloudLinkedKinguProfile,
  getCurrentKinguProfileAuthStatus,
  refreshCurrentKinguProfileAuth
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

describe('Kingu cloud profile service session refresh', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'kingu-cloud-service-refresh-'))
    beginKinguCloudPkceFlowMock.mockReset()
    createKinguCloudProfileMock.mockReset()
    exchangeKinguCloudAuthCodeMock.mockReset()
    refreshKinguCloudCapabilitiesMock.mockReset()
    refreshKinguCloudSessionMock.mockReset()
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

  it('refreshes an expired access token before creating cloud profiles', async () => {
    configureCloudEnv()
    mockSuccessfulConnect(Date.now() - 1_000)
    await connectCurrentKinguProfile(userDataPath)
    refreshKinguCloudSessionMock.mockResolvedValue({
      accessToken: 'rotated-access-token',
      refreshToken: 'rotated-refresh-token',
      expiresAt: futureExpiresAt(),
      cloud: cloudSummary,
      organizations,
      capabilities
    } satisfies KinguCloudSessionExchangeResponse)
    createKinguCloudProfileMock.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresAt: futureExpiresAt(),
      cloud: {
        ...cloudSummary,
        cloudProfileId: 'cloud-profile-2',
        activeOrgId: 'org-1',
        activeOrgName: 'Acme'
      },
      organizations,
      capabilities
    } satisfies KinguCloudSessionExchangeResponse)

    const result = await createCloudLinkedKinguProfile(userDataPath, {
      orgId: 'org-1',
      name: 'Acme'
    })

    expect(result.status).toBe('created')
    expect(refreshKinguCloudSessionMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ refreshToken: 'refresh-token' })
    )
    expect(createKinguCloudProfileMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ accessToken: 'rotated-access-token' }),
      { orgId: 'org-1', name: 'Acme' }
    )
  })

  it('refreshes capability flags for the connected profile', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    await connectCurrentKinguProfile(userDataPath)
    refreshKinguCloudCapabilitiesMock.mockResolvedValue({
      capabilities: {
        flags: { share: false, team: true },
        refreshedAt: 25
      }
    })

    const result = await refreshCurrentKinguProfileAuth(userDataPath)

    expect(result.status).toBe('refreshed')
    expect(refreshKinguCloudCapabilitiesMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ accessToken: 'access-token' })
    )
    expect(getCurrentKinguProfileAuthStatus(userDataPath).capabilities).toEqual({
      flags: { share: false, team: true },
      refreshedAt: 25
    })
  })

  it('clears stale active org metadata when capability refresh returns no active org', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    exchangeKinguCloudAuthCodeMock.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: futureExpiresAt(),
      cloud: { ...cloudSummary, activeOrgId: 'org-1', activeOrgName: 'Acme' },
      organizations,
      capabilities
    } satisfies KinguCloudSessionExchangeResponse)
    await connectCurrentKinguProfile(userDataPath)
    refreshKinguCloudCapabilitiesMock.mockResolvedValue({
      cloud: cloudSummary,
      organizations: [],
      capabilities: {
        flags: { share: false },
        refreshedAt: 31
      }
    })

    const result = await refreshCurrentKinguProfileAuth(userDataPath)
    const status = getCurrentKinguProfileAuthStatus(userDataPath)

    expect(result.status).toBe('refreshed')
    expect(status.cloud?.activeOrgId).toBeUndefined()
    expect(status.cloud?.activeOrgName).toBeUndefined()
    expect(status.organizations).toEqual([])
    expect(status.capabilities).toEqual({
      flags: { share: false },
      refreshedAt: 31
    })
  })

  it('requires reconnect when an expired refresh token is rejected', async () => {
    configureCloudEnv()
    mockSuccessfulConnect(Date.now() - 1_000)
    await connectCurrentKinguProfile(userDataPath)
    refreshKinguCloudSessionMock.mockRejectedValue(new KinguCloudRequestErrorMock(401))

    const result = await refreshCurrentKinguProfileAuth(userDataPath)

    expect(result.status).toBe('reconnect-required')
    expect(getCurrentKinguProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'reconnect-required',
      persistence: 'none',
      cloud: cloudSummary
    })
  })
})
