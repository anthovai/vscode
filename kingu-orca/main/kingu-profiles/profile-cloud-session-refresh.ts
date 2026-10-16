import type { KinguCloudAuthConfig } from './profile-cloud-auth-config'
import type { ActiveKinguProfileState } from './profile-index-store'
import { kinguCloudSessionKey, type KinguCloudSession } from './profile-cloud-session-store'
import {
  isAmbiguousCloudRequestFailure,
  KinguCloudRequestError,
  refreshKinguCloudSession
} from './profile-cloud-client'
import type { KinguCloudSessionExchangeResponse } from './profile-cloud-session-exchange'
import {
  AmbiguousRefreshReplayBlockedError,
  blocksAmbiguousRefreshReplay,
  forgetAmbiguousRefreshAttempt,
  recordAmbiguousRefreshAttempt,
  wasRefreshTokenAmbiguouslyAttempted
} from './profile-cloud-refresh-replay-guard'
import { emitKinguCloudSessionInvalidated } from './profile-cloud-session-invalidation'
import {
  commitCloudSessionRotation,
  readCloudSession,
  signOutRevokedCloudSession,
  takeCloudSessionTicket
} from './profile-cloud-session-owner'

const CLOUD_SESSION_REFRESH_SKEW_MS = 60_000

export type FreshCloudSessionResult =
  | { status: 'found'; session: KinguCloudSession }
  | { status: 'reconnect-required' }

export type CloudSessionOperationResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'reconnect-required' }

function shouldRefreshCloudSession(session: KinguCloudSession, now = Date.now()): boolean {
  return session.expiresAt <= now + CLOUD_SESSION_REFRESH_SKEW_MS
}

export function isKinguCloudAuthFailure(error: unknown): boolean {
  return (
    error instanceof KinguCloudRequestError &&
    (error.statusCode === 401 || error.statusCode === 403)
  )
}

const inflightCloudSessionRefreshes = new Map<string, Promise<KinguCloudSession>>()

class StaleCloudSessionMutationError extends Error {
  constructor() {
    super('stale_cloud_session_mutation')
  }
}

function clearCloudSessionIfUnchanged(
  profileId: string,
  userDataPath: string,
  failed: KinguCloudSession
): void {
  if (!signOutRevokedCloudSession(profileId, userDataPath, failed)) {
    return
  }
  forgetAmbiguousRefreshAttempt(kinguCloudSessionKey(profileId, userDataPath))
  // Why: the renderer cached auth status at startup; without this it keeps
  // showing "Connected" until the app restarts.
  emitKinguCloudSessionInvalidated()
}

// Why: support cannot otherwise tell a genuine revocation from a sign-out we
// caused ourselves by resending a refresh token whose first attempt never
// answered. Never log the token itself.
function warnIfPossibleRefreshReplay(
  profileId: string,
  userDataPath: string,
  failed: KinguCloudSession,
  error: unknown
): void {
  if (!(error instanceof KinguCloudRequestError) || error.statusCode !== 401) {
    return
  }
  const key = kinguCloudSessionKey(profileId, userDataPath)
  if (!wasRefreshTokenAmbiguouslyAttempted(key, failed.refreshToken)) {
    return
  }
  console.warn(
    '[kingu-cloud] kingu_cloud_refresh_possible_replay: refresh rejected 401 for a token whose earlier attempt never answered'
  )
}

type CloudSessionRefreshAttempt =
  | { status: 'refreshed'; response: KinguCloudSessionExchangeResponse }
  | { status: 'rotated-elsewhere'; session: KinguCloudSession }

function isRetryableCloudRefreshRejection(error: unknown): boolean {
  return error instanceof KinguCloudRequestError && error.statusCode >= 500
}

async function attemptCloudSessionRefresh(
  key: string,
  config: KinguCloudAuthConfig,
  active: ActiveKinguProfileState,
  userDataPath: string,
  session: KinguCloudSession
): Promise<CloudSessionRefreshAttempt> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await refreshKinguCloudSession(config, session)
      forgetAmbiguousRefreshAttempt(key)
      return { status: 'refreshed', response }
    } catch (error) {
      const ambiguous = isAmbiguousCloudRequestFailure(error)
      if (ambiguous) {
        recordAmbiguousRefreshAttempt(key, session.refreshToken)
      }
      // Only a status line proves the server rejected this token without
      // rotating it, so a definitive 5xx is the only failure worth retrying.
      const retryable = !ambiguous && attempt === 0 && isRetryableCloudRefreshRejection(error)
      if (!ambiguous && !retryable) {
        throw error
      }
      // Another caller may have rotated the stored session while this attempt
      // was in flight; that result is the one to use, and the token this attempt
      // held is no longer ours to send again.
      const current = readCloudSession(active.profile.id, userDataPath)
      if (current.status === 'found' && current.session.refreshToken !== session.refreshToken) {
        return { status: 'rotated-elsewhere', session: current.session }
      }
      if (ambiguous) {
        throw error
      }
    }
  }
}

async function refreshStoredCloudSession(
  config: KinguCloudAuthConfig,
  active: ActiveKinguProfileState,
  userDataPath: string,
  session: KinguCloudSession
): Promise<KinguCloudSession> {
  // Why: refresh tokens rotate, so concurrent refreshes must single-flight;
  // a second POST with the same refresh token can trip server reuse detection
  // and revoke the whole token family.
  const key = kinguCloudSessionKey(active.profile.id, userDataPath)
  const inflight = inflightCloudSessionRefreshes.get(key)
  if (inflight) {
    return inflight
  }
  const task = (async () => {
    const current = readCloudSession(active.profile.id, userDataPath)
    if (current.status === 'found' && current.session.refreshToken !== session.refreshToken) {
      // Another caller already rotated this session; reuse its result.
      return current.session
    }
    if (!active.profile.cloud) {
      throw new StaleCloudSessionMutationError()
    }
    if (blocksAmbiguousRefreshReplay(key, session.refreshToken)) {
      throw new AmbiguousRefreshReplayBlockedError()
    }
    const linked = active.profile.cloud
    const ticket = takeCloudSessionTicket(active.profile.id, userDataPath)
    const attempt = await attemptCloudSessionRefresh(key, config, active, userDataPath, session)
    if (attempt.status === 'rotated-elsewhere') {
      return attempt.session
    }
    const refreshed = attempt.response
    if (
      refreshed.cloud.userId !== linked.userId ||
      refreshed.cloud.cloudProfileId !== linked.cloudProfileId
    ) {
      throw new StaleCloudSessionMutationError()
    }
    const saved = commitCloudSessionRotation(
      active.profile.id,
      userDataPath,
      ticket,
      session,
      refreshed
    )
    if (!saved) {
      throw new StaleCloudSessionMutationError()
    }
    return saved
  })()
  inflightCloudSessionRefreshes.set(key, task)
  try {
    return await task
  } finally {
    inflightCloudSessionRefreshes.delete(key)
  }
}

export async function readFreshKinguCloudSession(
  config: KinguCloudAuthConfig,
  active: ActiveKinguProfileState,
  userDataPath: string
): Promise<FreshCloudSessionResult> {
  const session = readCloudSession(active.profile.id, userDataPath)
  if (session.status !== 'found') {
    return { status: 'reconnect-required' }
  }
  if (!shouldRefreshCloudSession(session.session)) {
    return { status: 'found', session: session.session }
  }
  try {
    return {
      status: 'found',
      session: await refreshStoredCloudSession(config, active, userDataPath, session.session)
    }
  } catch (error) {
    if (isKinguCloudAuthFailure(error)) {
      warnIfPossibleRefreshReplay(active.profile.id, userDataPath, session.session, error)
      clearCloudSessionIfUnchanged(active.profile.id, userDataPath, session.session)
      return { status: 'reconnect-required' }
    }
    throw error
  }
}

export async function forceRefreshKinguCloudSession(
  config: KinguCloudAuthConfig,
  active: ActiveKinguProfileState,
  userDataPath: string,
  session: KinguCloudSession
): Promise<FreshCloudSessionResult> {
  try {
    return {
      status: 'found',
      session: await refreshStoredCloudSession(config, active, userDataPath, session)
    }
  } catch (error) {
    if (isKinguCloudAuthFailure(error)) {
      warnIfPossibleRefreshReplay(active.profile.id, userDataPath, session, error)
      clearCloudSessionIfUnchanged(active.profile.id, userDataPath, session)
      return { status: 'reconnect-required' }
    }
    throw error
  }
}

export async function runWithFreshKinguCloudSession<T>(
  config: KinguCloudAuthConfig,
  active: ActiveKinguProfileState,
  userDataPath: string,
  operation: (session: KinguCloudSession) => Promise<T>
): Promise<CloudSessionOperationResult<T>> {
  const session = await readFreshKinguCloudSession(config, active, userDataPath)
  if (session.status !== 'found') {
    return { status: 'reconnect-required' }
  }
  try {
    return { status: 'ok', value: await operation(session.session) }
  } catch (error) {
    if (!isKinguCloudAuthFailure(error)) {
      throw error
    }
    const refreshed = await forceRefreshKinguCloudSession(
      config,
      active,
      userDataPath,
      session.session
    )
    if (refreshed.status !== 'found') {
      return { status: 'reconnect-required' }
    }
    try {
      return { status: 'ok', value: await operation(refreshed.session) }
    } catch (retryError) {
      // Why: a 401 after a successful refresh means the session itself is
      // rejected. A 403 is an authorization (permission) failure — signing
      // the user out for it would destroy a valid session, so let it surface
      // as a failed operation instead.
      if (retryError instanceof KinguCloudRequestError && retryError.statusCode === 401) {
        clearCloudSessionIfUnchanged(active.profile.id, userDataPath, refreshed.session)
        return { status: 'reconnect-required' }
      }
      throw retryError
    }
  }
}
