import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  listKinguProfileOrgMembersMock,
  inviteKinguProfileOrgMemberMock,
  revokeKinguProfileOrgInviteMock,
  changeKinguProfileOrgMemberRoleMock,
  removeKinguProfileOrgMemberMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  listKinguProfileOrgMembersMock: vi.fn(),
  inviteKinguProfileOrgMemberMock: vi.fn(),
  revokeKinguProfileOrgInviteMock: vi.fn(),
  changeKinguProfileOrgMemberRoleMock: vi.fn(),
  removeKinguProfileOrgMemberMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('../kingu-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/tmp/kingu-user-data'
}))

vi.mock('../kingu-profiles/profile-cloud-org-members-service', () => ({
  listKinguProfileOrgMembers: listKinguProfileOrgMembersMock,
  inviteKinguProfileOrgMember: inviteKinguProfileOrgMemberMock,
  revokeKinguProfileOrgInvite: revokeKinguProfileOrgInviteMock,
  changeKinguProfileOrgMemberRole: changeKinguProfileOrgMemberRoleMock,
  removeKinguProfileOrgMember: removeKinguProfileOrgMemberMock
}))

import { registerKinguProfileOrgMemberHandlers } from './kingu-profile-org-members-handlers'

function invoke(channel: string, args?: unknown): unknown {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`No handler for ${channel}`)
  }
  return handler({}, args)
}

describe('registerKinguProfileOrgMemberHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    listKinguProfileOrgMembersMock.mockReset().mockResolvedValue({ status: 'ok', roster: {} })
    inviteKinguProfileOrgMemberMock.mockReset().mockResolvedValue({ status: 'ok' })
    revokeKinguProfileOrgInviteMock.mockReset().mockResolvedValue({ status: 'ok' })
    changeKinguProfileOrgMemberRoleMock.mockReset().mockResolvedValue({ status: 'ok' })
    removeKinguProfileOrgMemberMock.mockReset().mockResolvedValue({ status: 'ok' })
    registerKinguProfileOrgMemberHandlers()
  })

  it('registers all five org-member channels', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [
        'kinguProfiles:orgInviteRevoke',
        'kinguProfiles:orgMemberChangeRole',
        'kinguProfiles:orgMemberInvite',
        'kinguProfiles:orgMemberRemove',
        'kinguProfiles:orgMembersList'
      ].sort()
    )
  })

  it('forwards a valid invite to the service with a trimmed email', async () => {
    await invoke('kinguProfiles:orgMemberInvite', {
      orgId: 'org-1',
      email: '  new@example.com  ',
      role: 'admin'
    })
    expect(inviteKinguProfileOrgMemberMock).toHaveBeenCalledWith('/tmp/kingu-user-data', {
      orgId: 'org-1',
      email: 'new@example.com',
      role: 'admin'
    })
  })

  it('rejects an invite with a missing org id', async () => {
    await expect(
      invoke('kinguProfiles:orgMemberInvite', { email: 'a@b.com', role: 'member' })
    ).rejects.toThrow('invalid_kingu_profile_org_selection')
    expect(inviteKinguProfileOrgMemberMock).not.toHaveBeenCalled()
  })

  it('rejects an invite with an unknown role', async () => {
    await expect(
      invoke('kinguProfiles:orgMemberInvite', { orgId: 'org-1', email: 'a@b.com', role: 'root' })
    ).rejects.toThrow('invalid_kingu_org_role')
  })

  it('rejects a role change with a blank user id', async () => {
    await expect(
      invoke('kinguProfiles:orgMemberChangeRole', { orgId: 'org-1', userId: '  ', role: 'admin' })
    ).rejects.toThrow('invalid_kingu_org_member_user')
  })

  it('forwards remove and revoke with validated args', async () => {
    await invoke('kinguProfiles:orgMemberRemove', { orgId: 'org-1', userId: 'user-2' })
    expect(removeKinguProfileOrgMemberMock).toHaveBeenCalledWith('/tmp/kingu-user-data', {
      orgId: 'org-1',
      userId: 'user-2'
    })
    await invoke('kinguProfiles:orgInviteRevoke', { orgId: 'org-1', email: 'gone@b.com' })
    expect(revokeKinguProfileOrgInviteMock).toHaveBeenCalledWith('/tmp/kingu-user-data', {
      orgId: 'org-1',
      email: 'gone@b.com'
    })
  })
})
