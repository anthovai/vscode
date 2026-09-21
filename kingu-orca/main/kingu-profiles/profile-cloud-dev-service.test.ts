import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  beginKinguCloudPkceFlowMock,
  exchangeKinguCloudAuthCodeMock,
  revokeKinguCloudSessionMock,
  safeStorageMock
} = vi.hoisted(() => ({
  beginKinguCloudPkceFlowMock: vi.fn(),
  exchangeKinguCloudAuthCodeMock: vi.fn(),
  revokeKinguCloudSessionMock: vi.fn(),
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
  createKinguCloudProfile: vi.fn(),
  exchangeKinguCloudAuthCode: exchangeKinguCloudAuthCodeMock,
  refreshKinguCloudCapabilities: vi.fn(),
  refreshKinguCloudSession: vi.fn(),
  revokeKinguCloudSession: revokeKinguCloudSessionMock,
  selectKinguCloudOrg: vi.fn()
}))

import {
  connectCurrentKinguProfile,
  createCloudLinkedKinguProfile,
  getCurrentKinguProfileAuthStatus,
  selectCurrentKinguProfileOrg,
  signOutCurrentKinguProfile
} from './profile-cloud-service'

describe('Kingu cloud dev auth service', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'kingu-cloud-dev-auth-'))
    beginKinguCloudPkceFlowMock.mockReset()
    exchangeKinguCloudAuthCodeMock.mockReset()
    revokeKinguCloudSessionMock.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf-8'))
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value, 'utf-8'))
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    vi.unstubAllEnvs()
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('KINGU_CLOUD_DEV_AUTH', '1')
    vi.stubEnv('KINGU_CLOUD_API_URL', '')
    vi.stubEnv('KINGU_CLOUD_CLIENT_ID', '')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('connects the active profile without PKCE or cloud endpoints', async () => {
    expect(getCurrentKinguProfileAuthStatus(userDataPath)).toMatchObject({
      configured: true,
      state: 'local'
    })

    const result = await connectCurrentKinguProfile(userDataPath)

    expect(result.status).toBe('connected')
    expect(beginKinguCloudPkceFlowMock).not.toHaveBeenCalled()
    expect(exchangeKinguCloudAuthCodeMock).not.toHaveBeenCalled()
    expect(getCurrentKinguProfileAuthStatus(userDataPath)).toMatchObject({
      configured: true,
      state: 'connected',
      persistence: 'encrypted',
      cloud: {
        cloudProfileId: 'dev-cloud-local-default',
        email: 'dev@kingu.local'
      },
      capabilities: {
        flags: expect.objectContaining({ 'share.create': true })
      }
    })
    expect(getCurrentKinguProfileAuthStatus(userDataPath).organizations).toHaveLength(2)
  })

  it('selects dev organizations and creates org-scoped cloud profiles locally', async () => {
    await connectCurrentKinguProfile(userDataPath)

    const selected = await selectCurrentKinguProfileOrg(userDataPath, 'dev-acme')
    const created = await createCloudLinkedKinguProfile(userDataPath, {
      orgId: 'dev-acme',
      name: 'Acme Dev'
    })

    expect(selected.status).toBe('selected')
    expect(getCurrentKinguProfileAuthStatus(userDataPath).cloud).toMatchObject({
      activeOrgId: 'dev-acme',
      activeOrgName: 'Acme Dev'
    })
    expect(created.status).toBe('created')
    if (created.status === 'created') {
      expect(created.profile).toMatchObject({
        name: 'Acme Dev',
        kind: 'cloud-linked',
        cloud: expect.objectContaining({
          activeOrgId: 'dev-acme',
          activeOrgName: 'Acme Dev'
        })
      })
    }
  })

  it('signs out locally without calling the cloud logout endpoint', async () => {
    await connectCurrentKinguProfile(userDataPath)

    const result = await signOutCurrentKinguProfile(userDataPath)

    expect(result.status).toBe('signed-out')
    expect(revokeKinguCloudSessionMock).not.toHaveBeenCalled()
    expect(getCurrentKinguProfileAuthStatus(userDataPath)).toMatchObject({
      configured: true,
      state: 'local',
      persistence: 'none'
    })
  })
})
