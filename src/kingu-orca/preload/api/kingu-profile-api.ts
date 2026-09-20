import type {
  ConnectCurrentKinguProfileResult,
  CreateCloudLinkedKinguProfileArgs,
  CreateCloudLinkedKinguProfileResult,
  CreateLocalKinguProfileArgs,
  CreateLocalKinguProfileResult,
  FindKinguProfileProjectsByPathArgs,
  FindKinguProfileProjectsByPathResult,
  KinguProfileAuthStatus,
  KinguProfileListResult,
  KinguProfileOrgInviteRevokeArgs,
  KinguProfileOrgMemberChangeRoleArgs,
  KinguProfileOrgMemberInviteArgs,
  KinguProfileOrgMemberMutationResult,
  KinguProfileOrgMemberRemoveArgs,
  KinguProfileOrgMembersListArgs,
  KinguProfileOrgMembersListResult,
  RefreshCurrentKinguProfileAuthResult,
  SelectKinguProfileOrgArgs,
  SelectKinguProfileOrgResult,
  SignOutCurrentKinguProfileResult,
  SwitchKinguProfileArgs,
  SwitchKinguProfileResult,
  TransferKinguProfileProjectArgs,
  TransferKinguProfileProjectResult
} from '../../shared/kingu-profiles'

export type KinguProfileApi = {
  list: () => Promise<KinguProfileListResult>
  authStatus: () => Promise<KinguProfileAuthStatus>
  /** Fires when main changed the stored auth status on its own (e.g. a revoked session). */
  onAuthStatusChanged: (callback: () => void) => () => void
  createLocal: (args?: CreateLocalKinguProfileArgs) => Promise<CreateLocalKinguProfileResult>
  createCloudLinked: (
    args?: CreateCloudLinkedKinguProfileArgs
  ) => Promise<CreateCloudLinkedKinguProfileResult>
  switchProfile: (args: SwitchKinguProfileArgs) => Promise<SwitchKinguProfileResult>
  transferProject: (
    args: TransferKinguProfileProjectArgs
  ) => Promise<TransferKinguProfileProjectResult>
  findProjectProfiles: (
    args: FindKinguProfileProjectsByPathArgs
  ) => Promise<FindKinguProfileProjectsByPathResult>
  connectCurrent: () => Promise<ConnectCurrentKinguProfileResult>
  refreshAuth: () => Promise<RefreshCurrentKinguProfileAuthResult>
  signOutCurrent: () => Promise<SignOutCurrentKinguProfileResult>
  selectOrg: (args: SelectKinguProfileOrgArgs) => Promise<SelectKinguProfileOrgResult>
  orgMembersList: (
    args: KinguProfileOrgMembersListArgs
  ) => Promise<KinguProfileOrgMembersListResult>
  orgMemberInvite: (
    args: KinguProfileOrgMemberInviteArgs
  ) => Promise<KinguProfileOrgMemberMutationResult>
  orgInviteRevoke: (
    args: KinguProfileOrgInviteRevokeArgs
  ) => Promise<KinguProfileOrgMemberMutationResult>
  orgMemberChangeRole: (
    args: KinguProfileOrgMemberChangeRoleArgs
  ) => Promise<KinguProfileOrgMemberMutationResult>
  orgMemberRemove: (
    args: KinguProfileOrgMemberRemoveArgs
  ) => Promise<KinguProfileOrgMemberMutationResult>
}
