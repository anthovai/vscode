import type {
  ConnectCurrentKinguProfileResult,
  CreateCloudLinkedKinguProfileArgs,
  CreateCloudLinkedKinguProfileResult,
  KinguProfileAuthStatus,
  SelectKinguProfileOrgResult,
  SignOutCurrentKinguProfileResult
} from '../../shared/kingu-profiles'
import { ensureActiveKinguProfile } from './profile-index-store'
import { getKinguCloudAuthConfig, isKinguCloudDevAuthEnabled } from './profile-cloud-auth-config'
import {
  clearKinguCloudSession,
  readKinguCloudSession,
  saveKinguCloudSessionExchange
} from './profile-cloud-session-store'
import { cloudSessionIdentity, tombstoneCloudSession } from './profile-cloud-session-mutation'
import {
  createKinguCloudProfile,
  exchangeKinguCloudAuthCode,
  revokeKinguCloudSession
} from './profile-cloud-client'
import { beginKinguCloudPkceFlow } from './profile-cloud-pkce'
import {
  createCloudLinkedKinguProfileRecord,
  linkKinguProfileToCloud,
  unlinkKinguProfileFromCloud
} from './profile-cloud-index'
import { runWithFreshKinguCloudSession } from './profile-cloud-session-refresh'
import {
  connectDevKinguCloudProfile,
  createDevCloudLinkedKinguProfile,
  selectDevKinguCloudOrg
} from './profile-cloud-dev-service'
import { getKinguProfileAuthStatusFromProfile } from './profile-cloud-auth-status'
import { selectCloudOrgWithMutationFence } from './profile-cloud-org-selection'

export { refreshCurrentKinguProfileAuth } from './profile-cloud-capability-refresh'

let nextCloudConnectAttempt = 0
let linkedCloudConnectAttempt = 0

function invalidateOutstandingCloudConnectAttempts(): void {
  nextCloudConnectAttempt += 1
  linkedCloudConnectAttempt = nextCloudConnectAttempt
}

function isUserCancelledAuthError(message: string): boolean {
  return message === 'kingu_cloud_auth_timeout' || message === 'kingu_cloud_auth_denied'
}

function activeAuth(
  active: ReturnType<typeof ensureActiveKinguProfile>,
  userDataPath: string
): KinguProfileAuthStatus {
  return getKinguProfileAuthStatusFromProfile(active, userDataPath)
}

export function getCurrentKinguProfileAuthStatus(userDataPath: string): KinguProfileAuthStatus {
  return getKinguProfileAuthStatusFromProfile(ensureActiveKinguProfile(userDataPath), userDataPath)
}

export async function connectCurrentKinguProfile(
  userDataPath: string
): Promise<ConnectCurrentKinguProfileResult> {
  const active = ensureActiveKinguProfile(userDataPath)
  if (isKinguCloudDevAuthEnabled()) {
    const list = connectDevKinguCloudProfile(active, userDataPath)
    return {
      status: 'connected',
      auth: getCurrentKinguProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  }

  const configState = getKinguCloudAuthConfig()
  if (!configState.configured) {
    return {
      status: 'unconfigured',
      auth: activeAuth(active, userDataPath)
    }
  }

  const attempt = ++nextCloudConnectAttempt
  try {
    const code = await beginKinguCloudPkceFlow(configState.config, active.profile.id)
    if (attempt < linkedCloudConnectAttempt) {
      return {
        status: 'cancelled',
        auth: getCurrentKinguProfileAuthStatus(userDataPath)
      }
    }
    const exchange = await exchangeKinguCloudAuthCode(configState.config, {
      ...code,
      localProfileId: active.profile.id
    })
    if (attempt < linkedCloudConnectAttempt) {
      return {
        status: 'cancelled',
        auth: getCurrentKinguProfileAuthStatus(userDataPath)
      }
    }
    saveKinguCloudSessionExchange(active.profile.id, userDataPath, exchange)
    const list = linkKinguProfileToCloud(active.profile.id, exchange.cloud, userDataPath)
    linkedCloudConnectAttempt = attempt
    return {
      status: 'connected',
      auth: getCurrentKinguProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isUserCancelledAuthError(message)) {
      return {
        status: 'cancelled',
        auth: getCurrentKinguProfileAuthStatus(userDataPath)
      }
    }
    return {
      status: 'failed',
      auth: getCurrentKinguProfileAuthStatus(userDataPath),
      error: message
    }
  }
}

export async function signOutCurrentKinguProfile(
  userDataPath: string
): Promise<SignOutCurrentKinguProfileResult> {
  // Why: a Sign in click still waiting in the browser must not relink after
  // the user explicitly signed out.
  invalidateOutstandingCloudConnectAttempts()
  const signOutEpoch = linkedCloudConnectAttempt
  const active = ensureActiveKinguProfile(userDataPath)
  const configState = getKinguCloudAuthConfig()
  const session = readKinguCloudSession(active.profile.id, userDataPath)
  if (active.profile.cloud) {
    // Why: persist the destructive fence before logout network I/O so a
    // refresh already in flight cannot save after explicit sign-out.
    tombstoneCloudSession(
      cloudSessionIdentity(active.profile.id, active.profile.cloud),
      userDataPath
    )
  }
  if (!isKinguCloudDevAuthEnabled() && configState.configured && session.status === 'found') {
    await revokeKinguCloudSession(configState.config, session.session).catch(() => undefined)
  }
  if (linkedCloudConnectAttempt > signOutEpoch) {
    const current = ensureActiveKinguProfile(userDataPath)
    return {
      status: 'signed-out',
      auth: getCurrentKinguProfileAuthStatus(userDataPath),
      activeProfileId: current.index.activeProfileId,
      profiles: current.index.profiles
    }
  }
  clearKinguCloudSession(active.profile.id, userDataPath)
  const list = unlinkKinguProfileFromCloud(active.profile.id, userDataPath)
  return {
    status: 'signed-out',
    auth: getCurrentKinguProfileAuthStatus(userDataPath),
    activeProfileId: list.activeProfileId,
    profiles: list.profiles
  }
}

export async function createCloudLinkedKinguProfile(
  userDataPath: string,
  args: CreateCloudLinkedKinguProfileArgs
): Promise<CreateCloudLinkedKinguProfileResult> {
  const active = ensureActiveKinguProfile(userDataPath)
  if (isKinguCloudDevAuthEnabled()) {
    const result = createDevCloudLinkedKinguProfile(active, userDataPath, args)
    if (result.status !== 'created') {
      return { status: 'reconnect-required', auth: activeAuth(active, userDataPath) }
    }
    return {
      status: 'created',
      auth: getCurrentKinguProfileAuthStatus(userDataPath),
      activeProfileId: result.list.activeProfileId,
      profiles: result.list.profiles,
      profile: result.list.profile
    }
  }

  const configState = getKinguCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured', auth: activeAuth(active, userDataPath) }
  }
  try {
    const operation = await runWithFreshKinguCloudSession(
      configState.config,
      active,
      userDataPath,
      (session) => createKinguCloudProfile(configState.config, session, args)
    )
    if (operation.status !== 'ok') {
      return { status: 'reconnect-required', auth: activeAuth(active, userDataPath) }
    }
    const created = operation.value
    const list = createCloudLinkedKinguProfileRecord(
      created.cloud,
      { name: args.name },
      userDataPath
    )
    saveKinguCloudSessionExchange(list.profile.id, userDataPath, created)
    return {
      status: 'created',
      auth: getCurrentKinguProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles,
      profile: list.profile
    }
  } catch (error) {
    return {
      status: 'failed',
      auth: getCurrentKinguProfileAuthStatus(userDataPath),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function selectCurrentKinguProfileOrg(
  userDataPath: string,
  orgId: string
): Promise<SelectKinguProfileOrgResult> {
  const active = ensureActiveKinguProfile(userDataPath)
  if (isKinguCloudDevAuthEnabled()) {
    const result = selectDevKinguCloudOrg(active, userDataPath, orgId)
    if (result.status !== 'updated') {
      return { status: 'reconnect-required', auth: activeAuth(active, userDataPath) }
    }
    return {
      status: 'selected',
      auth: getCurrentKinguProfileAuthStatus(userDataPath),
      activeProfileId: result.list.activeProfileId,
      profiles: result.list.profiles
    }
  }

  const configState = getKinguCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured', auth: activeAuth(active, userDataPath) }
  }
  try {
    const list = await selectCloudOrgWithMutationFence({
      config: configState.config,
      active,
      userDataPath,
      orgId
    })
    if (!list) {
      return { status: 'reconnect-required', auth: activeAuth(active, userDataPath) }
    }
    return {
      status: 'selected',
      auth: getCurrentKinguProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  } catch (error) {
    return {
      status: 'failed',
      auth: getCurrentKinguProfileAuthStatus(userDataPath),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
