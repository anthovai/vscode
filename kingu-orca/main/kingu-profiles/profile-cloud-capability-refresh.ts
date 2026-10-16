import type { RefreshCurrentKinguProfileAuthResult } from '../../shared/kingu-profiles'
import { getKinguCloudAuthConfig, isKinguCloudDevAuthEnabled } from './profile-cloud-auth-config'
import { getKinguProfileAuthStatusFromProfile } from './profile-cloud-auth-status'
import { refreshKinguCloudCapabilities } from './profile-cloud-client'
import { ensureActiveKinguProfile } from './profile-index-store'
import { refreshDevKinguCloudProfile } from './profile-cloud-dev-service'
import {
  commitCloudSessionCapabilities,
  takeCloudSessionTicket,
  type CloudSessionTicket
} from './profile-cloud-session-owner'
import { runWithFreshKinguCloudSession } from './profile-cloud-session-refresh'

export async function refreshCurrentKinguProfileAuth(
  userDataPath: string
): Promise<RefreshCurrentKinguProfileAuthResult> {
  const active = ensureActiveKinguProfile(userDataPath)
  const auth = () => getKinguProfileAuthStatusFromProfile(active, userDataPath)
  if (!active.profile.cloud) {
    return { status: 'local', auth: auth() }
  }
  if (isKinguCloudDevAuthEnabled()) {
    const result = refreshDevKinguCloudProfile(active, userDataPath)
    if (result.status !== 'updated') {
      return { status: 'reconnect-required', auth: auth() }
    }
    return {
      status: 'refreshed',
      auth: auth(),
      activeProfileId: result.list.activeProfileId,
      profiles: result.list.profiles
    }
  }
  const configState = getKinguCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured', auth: auth() }
  }
  try {
    const cloud = active.profile.cloud
    let ticket: CloudSessionTicket | undefined
    const operation = await runWithFreshKinguCloudSession(
      configState.config,
      active,
      userDataPath,
      (session) => {
        // Why: take the ticket at request time, after any refresh; that refresh may relink.
        ticket = takeCloudSessionTicket(active.profile.id, userDataPath)
        return refreshKinguCloudCapabilities(configState.config, session)
      }
    )
    if (operation.status !== 'ok' || !ticket) {
      return { status: 'reconnect-required', auth: auth() }
    }
    const refresh = operation.value
    if (
      refresh.cloud &&
      (refresh.cloud.userId !== cloud.userId ||
        refresh.cloud.cloudProfileId !== cloud.cloudProfileId)
    ) {
      throw new Error('kingu_cloud_identity_changed_during_capability_refresh')
    }
    const list = commitCloudSessionCapabilities(active.profile.id, userDataPath, ticket, refresh)
    if (!list) {
      return { status: 'reconnect-required', auth: auth() }
    }
    return {
      status: 'refreshed',
      auth: getKinguProfileAuthStatusFromProfile(
        ensureActiveKinguProfile(userDataPath),
        userDataPath
      ),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  } catch (error) {
    return {
      status: 'failed',
      auth: auth(),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
