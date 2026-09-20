import type {
  CreateCloudLinkedKinguProfileArgs,
  KinguProfileListState
} from '../../shared/kingu-profiles'
import type { ActiveKinguProfileState } from './profile-index-store'
import { createCloudLinkedKinguProfileRecord, linkKinguProfileToCloud } from './profile-cloud-index'
import { readKinguCloudSession, saveKinguCloudSessionExchange } from './profile-cloud-session-store'
import { createDevKinguCloudSession } from './profile-cloud-dev-auth'

type DevProfileListResult = KinguProfileListState

type DevCreateProfileResult =
  | {
      status: 'created'
      list: ReturnType<typeof createCloudLinkedKinguProfileRecord>
    }
  | { status: 'reconnect-required' }

type DevMutationResult =
  | {
      status: 'updated'
      list: DevProfileListResult
    }
  | { status: 'reconnect-required' }

export function connectDevKinguCloudProfile(
  active: ActiveKinguProfileState,
  userDataPath: string
): DevProfileListResult {
  const session = createDevKinguCloudSession({ localProfileId: active.profile.id })
  saveKinguCloudSessionExchange(active.profile.id, userDataPath, session)
  return linkKinguProfileToCloud(active.profile.id, session.cloud, userDataPath)
}

export function createDevCloudLinkedKinguProfile(
  active: ActiveKinguProfileState,
  userDataPath: string,
  args: CreateCloudLinkedKinguProfileArgs
): DevCreateProfileResult {
  if (readKinguCloudSession(active.profile.id, userDataPath).status !== 'found') {
    return { status: 'reconnect-required' }
  }
  const session = createDevKinguCloudSession({ orgId: args.orgId })
  const list = createCloudLinkedKinguProfileRecord(session.cloud, { name: args.name }, userDataPath)
  saveKinguCloudSessionExchange(list.profile.id, userDataPath, session)
  return { status: 'created', list }
}

export function refreshDevKinguCloudProfile(
  active: ActiveKinguProfileState,
  userDataPath: string
): DevMutationResult {
  if (
    !active.profile.cloud ||
    readKinguCloudSession(active.profile.id, userDataPath).status !== 'found'
  ) {
    return { status: 'reconnect-required' }
  }
  const session = createDevKinguCloudSession({
    localProfileId: active.profile.id,
    cloudProfileId: active.profile.cloud.cloudProfileId,
    orgId: active.profile.cloud.activeOrgId
  })
  saveKinguCloudSessionExchange(active.profile.id, userDataPath, session)
  return {
    status: 'updated',
    list: linkKinguProfileToCloud(active.profile.id, session.cloud, userDataPath)
  }
}

export function selectDevKinguCloudOrg(
  active: ActiveKinguProfileState,
  userDataPath: string,
  orgId: string
): DevMutationResult {
  if (
    !active.profile.cloud ||
    readKinguCloudSession(active.profile.id, userDataPath).status !== 'found'
  ) {
    return { status: 'reconnect-required' }
  }
  const session = createDevKinguCloudSession({
    localProfileId: active.profile.id,
    cloudProfileId: active.profile.cloud.cloudProfileId,
    orgId
  })
  saveKinguCloudSessionExchange(active.profile.id, userDataPath, session)
  return {
    status: 'updated',
    list: linkKinguProfileToCloud(active.profile.id, session.cloud, userDataPath)
  }
}
