import type { RefreshCurrentKinguProfileAuthResult } from '../../shared/kingu-profiles'
import { getKinguCloudAuthConfig, isKinguCloudDevAuthEnabled } from './profile-cloud-auth-config'
import { getKinguProfileAuthStatusFromProfile } from './profile-cloud-auth-status'
import { refreshKinguCloudCapabilities } from './profile-cloud-client'
import { linkKinguProfileToCloud } from './profile-cloud-index'
import { ensureActiveKinguProfile, getKinguProfileListState } from './profile-index-store'
import { refreshDevKinguCloudProfile } from './profile-cloud-dev-service'
import {
  captureCloudSessionMutation,
  cloudSessionIdentity,
  recordCloudSessionIdentityMutationIfCurrent
} from './profile-cloud-session-mutation'
import { runWithFreshKinguCloudSession } from './profile-cloud-session-refresh'
import {
  readKinguCloudSession,
  saveKinguCloudSessionIfCurrent
} from './profile-cloud-session-store'

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
    const identity = cloudSessionIdentity(active.profile.id, active.profile.cloud)
    let mutationSnapshot = captureCloudSessionMutation(identity, userDataPath)
    const operation = await runWithFreshKinguCloudSession(
      configState.config,
      active,
      userDataPath,
      (session) => refreshKinguCloudCapabilities(configState.config, session)
    )
    if (operation.status !== 'ok') {
      return { status: 'reconnect-required', auth: auth() }
    }
    const refresh = operation.value
    if (refresh.cloud) {
      const refreshedIdentity = cloudSessionIdentity(active.profile.id, refresh.cloud)
      if (
        refreshedIdentity.cloudUserId !== identity.cloudUserId ||
        refreshedIdentity.cloudProfileId !== identity.cloudProfileId
      ) {
        throw new Error('kingu_cloud_identity_changed_during_capability_refresh')
      }
      if (refreshedIdentity.organizationId !== identity.organizationId) {
        const advanced = recordCloudSessionIdentityMutationIfCurrent(
          refreshedIdentity,
          userDataPath,
          mutationSnapshot
        )
        if (!advanced) {
          return { status: 'reconnect-required', auth: auth() }
        }
        mutationSnapshot = advanced
      }
    }
    const session = readKinguCloudSession(active.profile.id, userDataPath)
    if (session.status !== 'found') {
      return { status: 'reconnect-required', auth: auth() }
    }
    if (
      saveKinguCloudSessionIfCurrent(
        active.profile.id,
        userDataPath,
        {
          ...session.session,
          organizations: refresh.organizations ?? session.session.organizations,
          capabilities: refresh.capabilities
        },
        mutationSnapshot
      ) === null
    ) {
      return { status: 'reconnect-required', auth: auth() }
    }
    const list = refresh.cloud
      ? linkKinguProfileToCloud(active.profile.id, refresh.cloud, userDataPath)
      : getKinguProfileListState(userDataPath)
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
