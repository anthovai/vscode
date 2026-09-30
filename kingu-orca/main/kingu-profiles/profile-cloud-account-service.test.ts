import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KinguCloudRequestError } from './profile-cloud-client'

const { runWithFreshKinguCloudSessionMock, ensureActiveKinguProfileMock, fetchMock } = vi.hoisted(
  () => ({
    runWithFreshKinguCloudSessionMock: vi.fn(),
    ensureActiveKinguProfileMock: vi.fn(),
    fetchMock: vi.fn()
  })
)

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

vi.mock('./profile-cloud-session-refresh', () => ({
  runWithFreshKinguCloudSession: runWithFreshKinguCloudSessionMock
}))

vi.mock('./profile-index-store', () => ({
  ensureActiveKinguProfile: ensureActiveKinguProfileMock
}))

import {
  accountRequestArgsFromUnknown,
  requestKinguProfileAccount
} from './profile-cloud-account-service'

const session = { accessToken: 'access-token' }
const cloudProfile = { profile: { id: 'profile-1', cloud: { email: 'a@b.com' } } }

// Mirrors the real contract: the operation runs with a live session; a 401 it
// throws becomes reconnect-required once the one retry also fails.
function runOperation(): void {
  runWithFreshKinguCloudSessionMock.mockImplementation(
    async (_config: unknown, _active: unknown, _path: unknown, op: (s: unknown) => unknown) => {
      try {
        return { status: 'ok', value: await op(session) }
      } catch (error) {
        if (error instanceof KinguCloudRequestError && error.statusCode === 401) {
          return { status: 'reconnect-required' }
        }
        throw error
      }
    }
  )
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('Kingu cloud account service', () => {
  beforeEach(() => {
    runWithFreshKinguCloudSessionMock.mockReset()
    ensureActiveKinguProfileMock.mockReset().mockReturnValue(cloudProfile)
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.unstubAllEnvs()
    vi.stubEnv('KINGU_CLOUD_DEV_AUTH', '')
    vi.stubEnv('KINGU_CLOUD_API_URL', 'https://kingu-cloud.example')
    vi.stubEnv('KINGU_CLOUD_CLIENT_ID', 'desktop-client')
    runOperation()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('reads the account with the session token, refusing redirects', async () => {
    const account = { email: 'a@b.com', plan: { id: 'free', name: 'Free' }, entitlement: null }
    fetchMock.mockResolvedValue(reply(200, account))

    await expect(requestKinguProfileAccount('', {})).resolves.toEqual({
      kind: 'response',
      status: 200,
      body: account
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect({ url, method: init.method, auth: init.headers.authorization, redirect: init.redirect }).toEqual({
      url: expect.stringMatching(/\/v1\/account$/),
      method: 'GET',
      auth: 'Bearer access-token',
      redirect: 'error'
    })
  })

  it('redeems a code and returns the cloud\'s refusal as an answer', async () => {
    fetchMock.mockResolvedValue(reply(409, { code: 'code_already_redeemed', message: 'Used' }))

    await expect(requestKinguProfileAccount('', { redeemCode: 'KINGU-123' })).resolves.toEqual({
      kind: 'response',
      status: 409,
      body: { code: 'code_already_redeemed', message: 'Used' }
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect({ url, method: init.method, body: init.body }).toEqual({
      url: expect.stringMatching(/\/v1\/account\/redeem$/),
      method: 'POST',
      body: JSON.stringify({ code: 'KINGU-123' })
    })
  })

  it('reports signed out on a rejected session or a local profile', async () => {
    fetchMock.mockResolvedValue(reply(401, { code: 'invalid_access_token' }))
    await expect(requestKinguProfileAccount('', {})).resolves.toEqual({ kind: 'signedOut' })

    ensureActiveKinguProfileMock.mockReturnValue({ profile: { id: 'local' } })
    await expect(requestKinguProfileAccount('', {})).resolves.toEqual({ kind: 'signedOut' })
  })

  it('checks the redeem code it is given', () => {
    expect(accountRequestArgsFromUnknown({ redeemCode: ' KINGU-1 ' })).toEqual({
      redeemCode: 'KINGU-1'
    })
    expect(accountRequestArgsFromUnknown(undefined)).toEqual({})
    expect(() => accountRequestArgsFromUnknown({ redeemCode: '  ' })).toThrow(
      'invalid_kingu_redeem_code'
    )
  })
})
