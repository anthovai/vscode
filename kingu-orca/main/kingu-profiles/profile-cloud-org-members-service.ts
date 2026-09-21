import type {
  KinguProfileOrgInviteRevokeArgs,
  KinguProfileOrgMemberChangeRoleArgs,
  KinguProfileOrgMemberInviteArgs,
  KinguProfileOrgMemberMutationResult,
  KinguProfileOrgMemberRemoveArgs,
  KinguProfileOrgMembersListResult
} from '../../shared/kingu-profiles'
import type { ActiveKinguProfileState } from './profile-index-store'
import { ensureActiveKinguProfile } from './profile-index-store'
import type { KinguCloudAuthConfig } from './profile-cloud-auth-config'
import { getKinguCloudAuthConfig, isKinguCloudDevAuthEnabled } from './profile-cloud-auth-config'
import type { KinguCloudSession } from './profile-cloud-session-store'
import { KinguCloudRequestError } from './profile-cloud-client'
import { runWithFreshKinguCloudSession } from './profile-cloud-session-refresh'
import {
  changeKinguCloudOrgMemberRole,
  inviteKinguCloudOrgMember,
  listKinguCloudOrgMembers,
  removeKinguCloudOrgMember,
  revokeKinguCloudOrgInvite
} from './profile-cloud-org-members-client'
import {
  changeDevKinguCloudOrgMemberRole,
  inviteDevKinguCloudOrgMember,
  listDevKinguCloudOrgMembers,
  removeDevKinguCloudOrgMember,
  revokeDevKinguCloudOrgInvite
} from './profile-cloud-dev-org-members'

type OrgCallResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'reconnect-required' }
  | { status: 'request-error'; error: KinguCloudRequestError }
  | { status: 'failed'; error: string }

// Why: only a 401 means the token itself is stale and should drive a session
// refresh/reconnect. 403/404/409/400 are business or permission outcomes the UI
// must interpret, so they are surfaced as values rather than thrown — otherwise
// runWithFreshKinguCloudSession would treat a 403 as an auth failure and burn a
// pointless token refresh + retry before giving up.
async function runOrgMemberCall<T>(
  config: KinguCloudAuthConfig,
  active: ActiveKinguProfileState,
  userDataPath: string,
  call: (session: KinguCloudSession) => Promise<T>
): Promise<OrgCallResult<T>> {
  try {
    const operation = await runWithFreshKinguCloudSession(
      config,
      active,
      userDataPath,
      async (session) => {
        try {
          return { ok: true as const, value: await call(session) }
        } catch (error) {
          if (error instanceof KinguCloudRequestError && error.statusCode !== 401) {
            return { ok: false as const, error }
          }
          throw error
        }
      }
    )
    if (operation.status !== 'ok') {
      return { status: 'reconnect-required' }
    }
    const outcome = operation.value
    return outcome.ok
      ? { status: 'ok', value: outcome.value }
      : { status: 'request-error', error: outcome.error }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

function mapMutationRequestError(
  error: KinguCloudRequestError
): KinguProfileOrgMemberMutationResult {
  switch (error.statusCode) {
    case 403:
      return { status: 'forbidden' }
    case 404:
      return { status: 'not-found' }
    case 409:
      return {
        status: 'conflict',
        reason: error.errorCode === 'already_member' ? 'already_member' : 'already_invited'
      }
    case 400:
      return {
        status: 'invalid',
        reason:
          error.errorCode === 'cannot_remove_self' ? 'cannot_remove_self' : 'cannot_change_own_role'
      }
    default:
      return { status: 'failed', error: error.message }
  }
}

function mapMutationResult(result: OrgCallResult<void>): KinguProfileOrgMemberMutationResult {
  switch (result.status) {
    case 'ok':
      return { status: 'ok' }
    case 'reconnect-required':
      return { status: 'reconnect-required' }
    case 'request-error':
      return mapMutationRequestError(result.error)
    case 'failed':
      return { status: 'failed', error: result.error }
  }
}

export async function listKinguProfileOrgMembers(
  userDataPath: string,
  orgId: string
): Promise<KinguProfileOrgMembersListResult> {
  const active = ensureActiveKinguProfile(userDataPath)
  if (isKinguCloudDevAuthEnabled()) {
    return { status: 'ok', roster: listDevKinguCloudOrgMembers(orgId) }
  }
  const configState = getKinguCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  const result = await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
    listKinguCloudOrgMembers(configState.config, session, orgId)
  )
  switch (result.status) {
    case 'ok':
      return { status: 'ok', roster: result.value }
    case 'reconnect-required':
      return { status: 'reconnect-required' }
    case 'request-error':
      return { status: 'failed', error: result.error.message }
    case 'failed':
      return { status: 'failed', error: result.error }
  }
}

export async function inviteKinguProfileOrgMember(
  userDataPath: string,
  args: KinguProfileOrgMemberInviteArgs
): Promise<KinguProfileOrgMemberMutationResult> {
  const active = ensureActiveKinguProfile(userDataPath)
  if (isKinguCloudDevAuthEnabled()) {
    return inviteDevKinguCloudOrgMember(args)
  }
  const configState = getKinguCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  return mapMutationResult(
    await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
      inviteKinguCloudOrgMember(configState.config, session, args)
    )
  )
}

export async function revokeKinguProfileOrgInvite(
  userDataPath: string,
  args: KinguProfileOrgInviteRevokeArgs
): Promise<KinguProfileOrgMemberMutationResult> {
  const active = ensureActiveKinguProfile(userDataPath)
  if (isKinguCloudDevAuthEnabled()) {
    return revokeDevKinguCloudOrgInvite(args)
  }
  const configState = getKinguCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  return mapMutationResult(
    await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
      revokeKinguCloudOrgInvite(configState.config, session, args)
    )
  )
}

export async function changeKinguProfileOrgMemberRole(
  userDataPath: string,
  args: KinguProfileOrgMemberChangeRoleArgs
): Promise<KinguProfileOrgMemberMutationResult> {
  const active = ensureActiveKinguProfile(userDataPath)
  if (isKinguCloudDevAuthEnabled()) {
    return changeDevKinguCloudOrgMemberRole(args)
  }
  const configState = getKinguCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  return mapMutationResult(
    await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
      changeKinguCloudOrgMemberRole(configState.config, session, args)
    )
  )
}

export async function removeKinguProfileOrgMember(
  userDataPath: string,
  args: KinguProfileOrgMemberRemoveArgs
): Promise<KinguProfileOrgMemberMutationResult> {
  const active = ensureActiveKinguProfile(userDataPath)
  if (isKinguCloudDevAuthEnabled()) {
    return removeDevKinguCloudOrgMember(args)
  }
  const configState = getKinguCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  return mapMutationResult(
    await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
      removeKinguCloudOrgMember(configState.config, session, args)
    )
  )
}
