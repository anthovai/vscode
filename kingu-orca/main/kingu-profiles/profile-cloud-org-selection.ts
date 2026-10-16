import type { KinguCloudAuthConfig } from './profile-cloud-auth-config'
import { KinguCloudRequestError, selectKinguCloudOrg } from './profile-cloud-client'
import { forceRefreshKinguCloudSession } from './profile-cloud-session-refresh'
import type { ActiveKinguProfileState } from './profile-index-store'
import type { KinguProfileListState } from '../../shared/kingu-profiles'
import {
  beginCloudSessionRelink,
  commitCloudSessionRelink,
  readCloudSession
} from './profile-cloud-session-owner'

export async function selectCloudOrg(input: {
  config: KinguCloudAuthConfig
  active: ActiveKinguProfileState
  userDataPath: string
  orgId: string
}): Promise<KinguProfileListState | null> {
  const profileId = input.active.profile.id
  const cloud = input.active.profile.cloud
  const stored = readCloudSession(profileId, input.userDataPath)
  if (!cloud || stored.status !== 'found') {
    return null
  }
  const ticket = beginCloudSessionRelink(profileId, input.userDataPath)
  let selected
  try {
    selected = await selectKinguCloudOrg(input.config, stored.session, input.orgId)
  } catch (error) {
    if (!(error instanceof KinguCloudRequestError) || error.statusCode !== 401) {
      throw error
    }
    const refreshed = await forceRefreshKinguCloudSession(
      input.config,
      input.active,
      input.userDataPath,
      stored.session
    )
    if (refreshed.status !== 'found') {
      throw error
    }
    selected = await selectKinguCloudOrg(input.config, refreshed.session, input.orgId)
  }
  if (
    selected.cloud.userId !== cloud.userId ||
    selected.cloud.cloudProfileId !== cloud.cloudProfileId ||
    selected.cloud.activeOrgId !== input.orgId
  ) {
    throw new Error('kingu_cloud_org_selection_identity_mismatch')
  }
  const list = commitCloudSessionRelink(profileId, input.userDataPath, ticket, selected)
  if (!list) {
    throw new Error('stale_cloud_session_mutation')
  }
  return list
}
