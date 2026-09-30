// Kingu: the signed-in account and its plan (`GET /v1/account`), and grant codes
// redeemed (`POST /v1/account/redeem`), for the IDE's Kingu Account pane. The
// request is made here, where the cloud session lives, so the access token
// never crosses to another process.
import type {
  KinguProfileAccountRequestArgs,
  KinguProfileAccountResult
} from '../../shared/kingu-profiles'
import { getKinguCloudAuthConfig, isKinguCloudDevAuthEnabled } from './profile-cloud-auth-config'
import type { KinguCloudAuthConfig } from './profile-cloud-auth-config'
import { KinguCloudRequestError } from './profile-cloud-client'
import { ensureActiveKinguProfile } from './profile-index-store'
import type { KinguCloudSession } from './profile-cloud-session-store'
import { runWithFreshKinguCloudSession } from './profile-cloud-session-refresh'

const CLOUD_REQUEST_TIMEOUT_MS = 30_000
const MAX_REDEEM_CODE_LENGTH = 200

type AccountResponse = { status: number; body: unknown }

export function accountRequestArgsFromUnknown(args: unknown): KinguProfileAccountRequestArgs {
  if (!args || typeof args !== 'object') {
    return {}
  }
  const code = (args as Record<string, unknown>).redeemCode
  if (code === undefined) {
    return {}
  }
  if (typeof code !== 'string' || !code.trim() || code.length > MAX_REDEEM_CODE_LENGTH) {
    throw new Error('invalid_kingu_redeem_code')
  }
  return { redeemCode: code.trim() }
}

// Why: a 401 is thrown so runWithFreshKinguCloudSession refreshes the session
// and retries once; every other status (404 invalid_code, 409 already
// redeemed…) is an answer the IDE words for the user, so it is returned.
// Redirects are refused: following one would send the token to another origin.
async function requestAccount(
  config: KinguCloudAuthConfig,
  session: KinguCloudSession,
  args: KinguProfileAccountRequestArgs
): Promise<AccountResponse> {
  const redeem = args.redeemCode !== undefined
  const response = await fetch(`${config.apiBaseUrl}/v1/account${redeem ? '/redeem' : ''}`, {
    method: redeem ? 'POST' : 'GET',
    headers: {
      ...(redeem ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${session.accessToken}`
    },
    ...(redeem ? { body: JSON.stringify({ code: args.redeemCode }) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS)
  })
  if (response.status === 401) {
    throw new KinguCloudRequestError(401)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  return { status: response.status, body }
}

export async function requestKinguProfileAccount(
  userDataPath: string,
  args: KinguProfileAccountRequestArgs
): Promise<KinguProfileAccountResult> {
  const active = ensureActiveKinguProfile(userDataPath)
  if (!active.profile.cloud) {
    return { kind: 'signedOut' }
  }
  if (isKinguCloudDevAuthEnabled()) {
    return { kind: 'unavailable', reason: 'Kingu cloud dev sign-in has no account plans.' }
  }
  const configState = getKinguCloudAuthConfig()
  if (!configState.configured) {
    return { kind: 'unavailable', reason: 'Kingu cloud is not configured in this build.' }
  }
  try {
    const result = await runWithFreshKinguCloudSession(
      configState.config,
      active,
      userDataPath,
      (session) => requestAccount(configState.config, session, args)
    )
    return result.status === 'ok'
      ? { kind: 'response', status: result.value.status, body: result.value.body }
      : { kind: 'signedOut' }
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
}
