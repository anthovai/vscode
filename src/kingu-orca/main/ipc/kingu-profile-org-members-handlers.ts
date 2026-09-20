import { ipcMain } from 'electron'
import type {
  KinguOrgRole,
  KinguProfileOrgInviteRevokeArgs,
  KinguProfileOrgMemberChangeRoleArgs,
  KinguProfileOrgMemberInviteArgs,
  KinguProfileOrgMemberMutationResult,
  KinguProfileOrgMemberRemoveArgs,
  KinguProfileOrgMembersListArgs,
  KinguProfileOrgMembersListResult
} from '../../shared/kingu-profiles'
import { getProfileUserDataPath } from '../kingu-profiles/profile-storage-paths'
import {
  changeKinguProfileOrgMemberRole,
  inviteKinguProfileOrgMember,
  listKinguProfileOrgMembers,
  removeKinguProfileOrgMember,
  revokeKinguProfileOrgInvite
} from '../kingu-profiles/profile-cloud-org-members-service'

function orgMembersScopedArgs(args: unknown): { orgId: string; record: Record<string, unknown> } {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_kingu_profile_org_selection')
  }
  const record = args as Record<string, unknown>
  const orgId = typeof record.orgId === 'string' ? record.orgId.trim() : ''
  if (!orgId) {
    throw new Error('invalid_kingu_profile_org_selection')
  }
  return { orgId, record }
}

function orgRoleFromUnknown(value: unknown): KinguOrgRole {
  if (value === 'owner' || value === 'admin' || value === 'member') {
    return value
  }
  throw new Error('invalid_kingu_org_role')
}

function orgEmailFromUnknown(value: unknown): string {
  const email = typeof value === 'string' ? value.trim() : ''
  if (!email) {
    throw new Error('invalid_kingu_org_member_email')
  }
  return email
}

function orgUserIdFromUnknown(value: unknown): string {
  const userId = typeof value === 'string' ? value.trim() : ''
  if (!userId) {
    throw new Error('invalid_kingu_org_member_user')
  }
  return userId
}

function orgMemberInviteArgsFromUnknown(args: unknown): KinguProfileOrgMemberInviteArgs {
  const { orgId, record } = orgMembersScopedArgs(args)
  return { orgId, email: orgEmailFromUnknown(record.email), role: orgRoleFromUnknown(record.role) }
}

function orgInviteRevokeArgsFromUnknown(args: unknown): KinguProfileOrgInviteRevokeArgs {
  const { orgId, record } = orgMembersScopedArgs(args)
  return { orgId, email: orgEmailFromUnknown(record.email) }
}

function orgMemberChangeRoleArgsFromUnknown(args: unknown): KinguProfileOrgMemberChangeRoleArgs {
  const { orgId, record } = orgMembersScopedArgs(args)
  return {
    orgId,
    userId: orgUserIdFromUnknown(record.userId),
    role: orgRoleFromUnknown(record.role)
  }
}

function orgMemberRemoveArgsFromUnknown(args: unknown): KinguProfileOrgMemberRemoveArgs {
  const { orgId, record } = orgMembersScopedArgs(args)
  return { orgId, userId: orgUserIdFromUnknown(record.userId) }
}

export function registerKinguProfileOrgMemberHandlers(): void {
  ipcMain.handle(
    'kinguProfiles:orgMembersList',
    async (
      _event,
      rawArgs: KinguProfileOrgMembersListArgs
    ): Promise<KinguProfileOrgMembersListResult> =>
      listKinguProfileOrgMembers(getProfileUserDataPath(), orgMembersScopedArgs(rawArgs).orgId)
  )

  ipcMain.handle(
    'kinguProfiles:orgMemberInvite',
    async (
      _event,
      rawArgs: KinguProfileOrgMemberInviteArgs
    ): Promise<KinguProfileOrgMemberMutationResult> =>
      inviteKinguProfileOrgMember(getProfileUserDataPath(), orgMemberInviteArgsFromUnknown(rawArgs))
  )

  ipcMain.handle(
    'kinguProfiles:orgInviteRevoke',
    async (
      _event,
      rawArgs: KinguProfileOrgInviteRevokeArgs
    ): Promise<KinguProfileOrgMemberMutationResult> =>
      revokeKinguProfileOrgInvite(getProfileUserDataPath(), orgInviteRevokeArgsFromUnknown(rawArgs))
  )

  ipcMain.handle(
    'kinguProfiles:orgMemberChangeRole',
    async (
      _event,
      rawArgs: KinguProfileOrgMemberChangeRoleArgs
    ): Promise<KinguProfileOrgMemberMutationResult> =>
      changeKinguProfileOrgMemberRole(
        getProfileUserDataPath(),
        orgMemberChangeRoleArgsFromUnknown(rawArgs)
      )
  )

  ipcMain.handle(
    'kinguProfiles:orgMemberRemove',
    async (
      _event,
      rawArgs: KinguProfileOrgMemberRemoveArgs
    ): Promise<KinguProfileOrgMemberMutationResult> =>
      removeKinguProfileOrgMember(getProfileUserDataPath(), orgMemberRemoveArgsFromUnknown(rawArgs))
  )
}
