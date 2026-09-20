import { KINGU_BROWSER_PARTITION } from './constants'
import type { ExecutionHostId } from './execution-host'

export const KINGU_PROFILE_INDEX_SCHEMA_VERSION = 1
export const DEFAULT_LOCAL_KINGU_PROFILE_ID = 'local-default'
export const DEFAULT_LOCAL_KINGU_PROFILE_NAME = 'Personal'
/** Main -> renderer push when the stored auth status changed without the renderer asking. */
export const KINGU_PROFILE_AUTH_STATUS_CHANGED_CHANNEL = 'kinguProfiles:authStatusChanged'
const LEGACY_KINGU_BROWSER_SESSION_PARTITION_PREFIX = 'persist:kingu-browser-session-'

export type KinguProfileAvatar = {
  kind: 'initials'
  initials: string
  color: 'neutral'
}

export type KinguProfileKind = 'local' | 'cloud-linked'

export type KinguProfileCloudSummary = {
  cloudProfileId: string
  userId: string
  email: string
  displayName?: string
  activeOrgId?: string
  activeOrgName?: string
  linkedAt: number
}

export type KinguCloudOrgSummary = {
  orgId: string
  name: string
  role?: string
}

export type KinguCloudCapabilityFlags = Record<string, boolean>

export type KinguCloudCapabilities = {
  flags: KinguCloudCapabilityFlags
  refreshedAt: number
}

export type KinguCloudSessionPersistence = 'none' | 'encrypted' | 'memory-only' | 'dev-plaintext'

export type KinguProfileAuthState = 'local' | 'unconfigured' | 'connected' | 'reconnect-required'

export type KinguProfileAuthStatus = {
  activeProfileId: string
  configured: boolean
  state: KinguProfileAuthState
  persistence: KinguCloudSessionPersistence
  cloud?: KinguProfileCloudSummary
  organizations?: KinguCloudOrgSummary[]
  capabilities?: KinguCloudCapabilities
  credentialError?: string
  setupMessage?: string
}

export type KinguProfileSummary = {
  id: string
  name: string
  avatar: KinguProfileAvatar
  kind: KinguProfileKind
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  cloud?: KinguProfileCloudSummary
}

export type KinguProfileIndex = {
  schemaVersion: number
  activeProfileId: string
  profiles: KinguProfileSummary[]
}

export type KinguProfileListState = {
  activeProfileId: string
  profiles: KinguProfileSummary[]
}

export type KinguProfileListResult = KinguProfileListState & {
  // Why: gates the full multi-profile switcher UI; default builds show a
  // single-profile account menu instead.
  multiProfileUi: boolean
}

export type CreateLocalKinguProfileArgs = {
  name?: string
}

export type CreateLocalKinguProfileResult = KinguProfileListState & {
  profile: KinguProfileSummary
}

export type CreateCloudLinkedKinguProfileArgs = {
  orgId?: string
  name?: string
}

export type SwitchKinguProfileArgs = {
  profileId: string
}

export type SwitchKinguProfileResult = {
  status: 'already-active' | 'relaunching'
}

export type TransferKinguProfileProjectMode = 'move' | 'copy'

export type TransferKinguProfileProjectArgs = {
  sourceProfileId: string
  targetProfileId: string
  repoId: string
  mode: TransferKinguProfileProjectMode
}

export type FindKinguProfileProjectsByPathArgs = {
  path: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  excludeProfileId?: string | null
}

export type KinguProfileProjectPresence = {
  profileId: string
  profileName: string
  profileKind: KinguProfileKind
  repoId: string
  repoName: string
}

export type FindKinguProfileProjectsByPathResult = {
  projects: KinguProfileProjectPresence[]
}

export type TransferKinguProfileProjectResult =
  | {
      status: 'transferred'
      mode: TransferKinguProfileProjectMode
      sourceProfileId: string
      targetProfileId: string
      sourceRepoId: string
      targetRepoId: string
      targetProjectId: string | null
      willRelaunch?: boolean
    }
  | {
      status: 'duplicate-target'
      sourceProfileId: string
      targetProfileId: string
      sourceRepoId: string
      duplicateRepoId: string
    }

export type ConnectCurrentKinguProfileResult =
  | {
      status: 'connected'
      auth: KinguProfileAuthStatus
      activeProfileId: string
      profiles: KinguProfileSummary[]
    }
  | {
      status: 'unconfigured'
      auth: KinguProfileAuthStatus
    }
  | {
      status: 'cancelled'
      auth: KinguProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: KinguProfileAuthStatus
      error: string
    }

export type CreateCloudLinkedKinguProfileResult =
  | {
      status: 'created'
      auth: KinguProfileAuthStatus
      activeProfileId: string
      profiles: KinguProfileSummary[]
      profile: KinguProfileSummary
    }
  | {
      status: 'unconfigured' | 'reconnect-required'
      auth: KinguProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: KinguProfileAuthStatus
      error: string
    }

export type SignOutCurrentKinguProfileResult = {
  status: 'signed-out'
  auth: KinguProfileAuthStatus
  activeProfileId: string
  profiles: KinguProfileSummary[]
}

export type SelectKinguProfileOrgArgs = {
  orgId: string
}

export type SelectKinguProfileOrgResult =
  | {
      status: 'selected'
      auth: KinguProfileAuthStatus
      activeProfileId: string
      profiles: KinguProfileSummary[]
    }
  | {
      status: 'unconfigured' | 'reconnect-required'
      auth: KinguProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: KinguProfileAuthStatus
      error: string
    }

export type RefreshCurrentKinguProfileAuthResult =
  | {
      status: 'refreshed'
      auth: KinguProfileAuthStatus
      activeProfileId: string
      profiles: KinguProfileSummary[]
    }
  | {
      status: 'local' | 'unconfigured' | 'reconnect-required'
      auth: KinguProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: KinguProfileAuthStatus
      error: string
    }

// Why: organization roles are a fixed server-side enum; the desktop UI mirrors
// exactly these three so role selects can't drift from what the API accepts.
export type KinguOrgRole = 'owner' | 'admin' | 'member'

export type KinguOrgMember = {
  // Why: null for teammates provisioned server-side who never signed into Kingu;
  // mutation actions are disabled for them since the API keys on a real userId.
  userId: string | null
  email: string
  displayName?: string
  role: KinguOrgRole
}

export type KinguOrgPendingInvite = {
  email: string
  role: KinguOrgRole
  createdAt: number
}

export type KinguOrgMembersRoster = {
  members: KinguOrgMember[]
  pendingInvites: KinguOrgPendingInvite[]
  viewerRole: KinguOrgRole
  canManageMembers: boolean
}

export type KinguProfileOrgMembersListArgs = {
  orgId: string
}

export type KinguProfileOrgMemberInviteArgs = {
  orgId: string
  email: string
  role: KinguOrgRole
}

export type KinguProfileOrgInviteRevokeArgs = {
  orgId: string
  email: string
}

export type KinguProfileOrgMemberChangeRoleArgs = {
  orgId: string
  userId: string
  role: KinguOrgRole
}

export type KinguProfileOrgMemberRemoveArgs = {
  orgId: string
  userId: string
}

export type KinguProfileOrgMembersListResult =
  | { status: 'ok'; roster: KinguOrgMembersRoster }
  | { status: 'unconfigured' | 'reconnect-required' }
  | { status: 'failed'; error: string }

export type KinguOrgInviteConflictReason = 'already_member' | 'already_invited'
export type KinguOrgMutationInvalidReason = 'cannot_change_own_role' | 'cannot_remove_self'

export type KinguProfileOrgMemberMutationResult =
  | { status: 'ok' }
  | { status: 'unconfigured' | 'reconnect-required' | 'forbidden' | 'not-found' }
  | { status: 'conflict'; reason: KinguOrgInviteConflictReason }
  | { status: 'invalid'; reason: KinguOrgMutationInvalidReason }
  | { status: 'failed'; error: string }

export function createDefaultLocalKinguProfile(now: number): KinguProfileSummary {
  return {
    id: DEFAULT_LOCAL_KINGU_PROFILE_ID,
    name: DEFAULT_LOCAL_KINGU_PROFILE_NAME,
    avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
    kind: 'local',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now
  }
}

function profilePartitionHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function getKinguProfileBrowserPartitionSegment(profileId: string): string {
  const safe = profileId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'profile'
  return `${safe}-${profilePartitionHash(profileId)}`
}

export function getKinguProfileBrowserDefaultPartition(profileId: string): string {
  if (profileId === DEFAULT_LOCAL_KINGU_PROFILE_ID) {
    return KINGU_BROWSER_PARTITION
  }
  return `persist:kingu-profile-${getKinguProfileBrowserPartitionSegment(profileId)}-browser-default`
}

export function getKinguProfileBrowserSessionPartition(
  profileId: string,
  browserSessionProfileId: string
): string {
  if (profileId === DEFAULT_LOCAL_KINGU_PROFILE_ID) {
    return `${LEGACY_KINGU_BROWSER_SESSION_PARTITION_PREFIX}${browserSessionProfileId}`
  }
  return `persist:kingu-profile-${getKinguProfileBrowserPartitionSegment(
    profileId
  )}-browser-session-${browserSessionProfileId}`
}
