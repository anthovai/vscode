import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KinguOrgMembersRoster } from '../../shared/kingu-profiles'
import { KinguCloudRequestError } from './profile-cloud-client'

const {
  runWithFreshKinguCloudSessionMock,
  listKinguCloudOrgMembersMock,
  inviteKinguCloudOrgMemberMock,
  revokeKinguCloudOrgInviteMock,
  changeKinguCloudOrgMemberRoleMock,
  removeKinguCloudOrgMemberMock
} = vi.hoisted(() => ({
  runWithFreshKinguCloudSessionMock: vi.fn(),
  listKinguCloudOrgMembersMock: vi.fn(),
  inviteKinguCloudOrgMemberMock: vi.fn(),
  revokeKinguCloudOrgInviteMock: vi.fn(),
  changeKinguCloudOrgMemberRoleMock: vi.fn(),
  removeKinguCloudOrgMemberMock: vi.fn()
}))

let userDataPath = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath }
}))

vi.mock('./profile-cloud-session-refresh', () => ({
  runWithFreshKinguCloudSessionMock,
  runWithFreshKinguCloudSession: runWithFreshKinguCloudSessionMock
}))

vi.mock('./profile-cloud-org-members-client', () => ({
  listKinguCloudOrgMembers: listKinguCloudOrgMembersMock,
  inviteKinguCloudOrgMember: inviteKinguCloudOrgMemberMock,
  revokeKinguCloudOrgInvite: revokeKinguCloudOrgInviteMock,
  changeKinguCloudOrgMemberRole: changeKinguCloudOrgMemberRoleMock,
  removeKinguCloudOrgMember: removeKinguCloudOrgMemberMock
}))

import {
  changeKinguProfileOrgMemberRole,
  inviteKinguProfileOrgMember,
  listKinguProfileOrgMembers,
  removeKinguProfileOrgMember,
  revokeKinguProfileOrgInvite
} from './profile-cloud-org-members-service'

const fakeSession = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 3_600_000,
  capabilities: { flags: {}, refreshedAt: 1 }
}

// Why: mirror the real contract — invoke the operation with a live session and
// surface its resolved value; business 4xx are returned by the operation as
// values, never thrown, so the session layer never sees them.
function runOperationDirectly(): void {
  runWithFreshKinguCloudSessionMock.mockImplementation(
    async (
      _config: unknown,
      _active: unknown,
      _path: unknown,
      op: (session: unknown) => unknown
    ) => ({
      status: 'ok',
      value: await op(fakeSession)
    })
  )
}

function configureCloudEnv(): void {
  vi.stubEnv('KINGU_CLOUD_API_URL', 'https://kingu-cloud.example')
  vi.stubEnv('KINGU_CLOUD_CLIENT_ID', 'desktop-client')
}

const roster: KinguOrgMembersRoster = {
  members: [{ userId: 'user-1', email: 'nina@example.com', role: 'owner' }],
  pendingInvites: [],
  viewerRole: 'owner',
  canManageMembers: true
}

describe('Kingu cloud org members service (configured)', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'kingu-org-members-'))
    runWithFreshKinguCloudSessionMock.mockReset()
    listKinguCloudOrgMembersMock.mockReset()
    inviteKinguCloudOrgMemberMock.mockReset()
    revokeKinguCloudOrgInviteMock.mockReset()
    changeKinguCloudOrgMemberRoleMock.mockReset()
    removeKinguCloudOrgMemberMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('KINGU_CLOUD_DEV_AUTH', '')
    vi.stubEnv('KINGU_CLOUD_API_URL', '')
    vi.stubEnv('KINGU_CLOUD_CLIENT_ID', '')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('reports unconfigured when cloud sign-in is not set up', async () => {
    await expect(listKinguProfileOrgMembers(userDataPath, 'org-1')).resolves.toEqual({
      status: 'unconfigured'
    })
    expect(runWithFreshKinguCloudSessionMock).not.toHaveBeenCalled()
  })

  it('returns the roster from the client', async () => {
    configureCloudEnv()
    runOperationDirectly()
    listKinguCloudOrgMembersMock.mockResolvedValue(roster)

    await expect(listKinguProfileOrgMembers(userDataPath, 'org-1')).resolves.toEqual({
      status: 'ok',
      roster
    })
    expect(listKinguCloudOrgMembersMock).toHaveBeenCalledWith(
      expect.any(Object),
      fakeSession,
      'org-1'
    )
  })

  it('maps a 409 already_member invite conflict', async () => {
    configureCloudEnv()
    runOperationDirectly()
    inviteKinguCloudOrgMemberMock.mockRejectedValue(
      new KinguCloudRequestError(409, 'already_member')
    )

    await expect(
      inviteKinguProfileOrgMember(userDataPath, {
        orgId: 'org-1',
        email: 'a@b.com',
        role: 'member'
      })
    ).resolves.toEqual({ status: 'conflict', reason: 'already_member' })
  })

  it('maps a 403 role change to forbidden', async () => {
    configureCloudEnv()
    runOperationDirectly()
    changeKinguCloudOrgMemberRoleMock.mockRejectedValue(new KinguCloudRequestError(403))

    await expect(
      changeKinguProfileOrgMemberRole(userDataPath, {
        orgId: 'org-1',
        userId: 'user-2',
        role: 'admin'
      })
    ).resolves.toEqual({ status: 'forbidden' })
  })

  it('maps a 400 cannot_remove_self to an invalid result', async () => {
    configureCloudEnv()
    runOperationDirectly()
    removeKinguCloudOrgMemberMock.mockRejectedValue(
      new KinguCloudRequestError(400, 'cannot_remove_self')
    )

    await expect(
      removeKinguProfileOrgMember(userDataPath, { orgId: 'org-1', userId: 'user-1' })
    ).resolves.toEqual({ status: 'invalid', reason: 'cannot_remove_self' })
  })

  it('maps a 404 revoke to not-found', async () => {
    configureCloudEnv()
    runOperationDirectly()
    revokeKinguCloudOrgInviteMock.mockRejectedValue(new KinguCloudRequestError(404))

    await expect(
      revokeKinguProfileOrgInvite(userDataPath, { orgId: 'org-1', email: 'gone@b.com' })
    ).resolves.toEqual({ status: 'not-found' })
  })

  it('reports reconnect-required when the session layer cannot refresh', async () => {
    configureCloudEnv()
    runWithFreshKinguCloudSessionMock.mockResolvedValue({ status: 'reconnect-required' })

    await expect(listKinguProfileOrgMembers(userDataPath, 'org-1')).resolves.toEqual({
      status: 'reconnect-required'
    })
  })
})

describe('Kingu cloud org members service (dev auth)', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'kingu-org-members-dev-'))
    runWithFreshKinguCloudSessionMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('KINGU_CLOUD_DEV_AUTH', '1')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('serves an in-memory roster the caller can manage', async () => {
    const result = await listKinguProfileOrgMembers(userDataPath, 'dev-list-org')
    if (result.status !== 'ok') {
      throw new Error(`Expected ok, got ${result.status}`)
    }
    expect(result.roster.canManageMembers).toBe(true)
    expect(result.roster.viewerRole).toBe('owner')
    expect(result.roster.members[0]).toMatchObject({ role: 'owner' })
    expect(result.roster.members.some((member) => member.userId === null)).toBe(true)
    expect(result.roster.pendingInvites.length).toBeGreaterThan(0)
    expect(runWithFreshKinguCloudSessionMock).not.toHaveBeenCalled()
  })

  it('mutates the dev roster across invite and revoke', async () => {
    const orgId = 'dev-mutate-org'
    await expect(
      inviteKinguProfileOrgMember(userDataPath, {
        orgId,
        email: 'fresh@kingu.local',
        role: 'member'
      })
    ).resolves.toEqual({ status: 'ok' })

    const afterInvite = await listKinguProfileOrgMembers(userDataPath, orgId)
    if (afterInvite.status !== 'ok') {
      throw new Error('expected ok')
    }
    expect(afterInvite.roster.pendingInvites.some((i) => i.email === 'fresh@kingu.local')).toBe(
      true
    )

    await expect(
      inviteKinguProfileOrgMember(userDataPath, {
        orgId,
        email: 'fresh@kingu.local',
        role: 'member'
      })
    ).resolves.toEqual({ status: 'conflict', reason: 'already_invited' })

    await expect(
      revokeKinguProfileOrgInvite(userDataPath, { orgId, email: 'fresh@kingu.local' })
    ).resolves.toEqual({ status: 'ok' })
    await expect(
      revokeKinguProfileOrgInvite(userDataPath, { orgId, email: 'fresh@kingu.local' })
    ).resolves.toEqual({ status: 'not-found' })
  })

  it('blocks changing the dev owner (self) role', async () => {
    const orgId = 'dev-self-org'
    const list = await listKinguProfileOrgMembers(userDataPath, orgId)
    if (list.status !== 'ok') {
      throw new Error('expected ok')
    }
    const self = list.roster.members.find((member) => member.role === 'owner')
    await expect(
      changeKinguProfileOrgMemberRole(userDataPath, {
        orgId,
        userId: self?.userId ?? 'dev-user',
        role: 'member'
      })
    ).resolves.toEqual({ status: 'invalid', reason: 'cannot_change_own_role' })
  })
})
