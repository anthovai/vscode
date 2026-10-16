import type {
  CreateCloudLinkedKinguProfileArgs,
  KinguProfileListState
} from '../../shared/kingu-profiles'
import type { ActiveKinguProfileState } from './profile-index-store'
import { createCloudLinkedKinguProfileRecord, linkKinguProfileToCloud } from './profile-cloud-index'
import { readCloudSession, signInCloudSession } from './profile-cloud-session-owner'
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
  signInCloudSession(active.profile.id, userDataPath, session)
  return linkKinguProfileToCloud(active.profile.id, session.cloud, userDataPath)
}

export function createDevCloudLinkedKinguProfile(
  active: ActiveKinguProfileState,
  userDataPath: string,
  args: CreateCloudLinkedKinguProfileArgs
): DevCreateProfileResult {
  if (readCloudSession(active.profile.id, userDataPath).status !== 'found') {
    return { status: 'reconnect-required' }
  }
  const session = createDevKinguCloudSession({ orgId: args.orgId })
  const list = createCloudLinkedKinguProfileRecord(session.cloud, { name: args.name }, userDataPath)
  signInCloudSession(list.profile.id, userDataPath, session)
  return { status: 'created', list }
}

export function refreshDevKinguCloudProfile(
  active: ActiveKinguProfileState,
  userDataPath: string
): DevMutationResult {
  if (
    !active.profile.cloud ||
    readCloudSession(active.profile.id, userDataPath).status !== 'found'
  ) {
    return { status: 'reconnect-required' }
  }
  const session = createDevKinguCloudSession({
    localProfileId: active.profile.id,
    cloudProfileId: active.profile.cloud.cloudProfileId,
    orgId: active.profile.cloud.activeOrgId
  })
  signInCloudSession(active.profile.id, userDataPath, session)
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
    readCloudSession(active.profile.id, userDataPath).status !== 'found'
  ) {
    return { status: 'reconnect-required' }
  }
  const session = createDevKinguCloudSession({
    localProfileId: active.profile.id,
    cloudProfileId: active.profile.cloud.cloudProfileId,
    orgId
  })
  signInCloudSession(active.profile.id, userDataPath, session)
  return {
    status: 'updated',
    list: linkKinguProfileToCloud(active.profile.id, session.cloud, userDataPath)
  }
}
