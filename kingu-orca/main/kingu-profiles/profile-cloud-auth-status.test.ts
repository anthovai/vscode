import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveKinguProfileState } from './profile-index-store'
import type { KinguCloudSessionReadResult } from './profile-cloud-session-store'
import { getKinguProfileAuthStatusFromProfile } from './profile-cloud-auth-status'

const { readSession, configuration } = vi.hoisted(() => ({
  readSession: vi.fn<() => KinguCloudSessionReadResult>(),
  configuration: { configured: true }
}))

vi.mock('./profile-cloud-session-store', () => ({ readKinguCloudSession: readSession }))
vi.mock('./profile-cloud-auth-config', () => ({
  getKinguCloudAuthConfig: () => configuration,
  isKinguCloudDevAuthEnabled: () => false
}))

function activeProfile(linked: boolean): ActiveKinguProfileState {
  const profile: ActiveKinguProfileState['profile'] = {
    id: 'profile-1',
    name: 'Personal',
    avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
    kind: linked ? 'cloud-linked' : 'local',
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
    ...(linked
      ? {
          cloud: {
            cloudProfileId: 'cloud-1',
            userId: 'user-1',
            email: 'a@example.com',
            linkedAt: 0
          }
        }
      : {})
  }
  return {
    profile,
    index: { schemaVersion: 1, activeProfileId: profile.id, profiles: [profile] },
    dataFile: '',
    profileDirectory: ''
  }
}

const absentSessions: KinguCloudSessionReadResult[] = [
  { status: 'missing', persistence: 'none' },
  { status: 'decrypt-failed', persistence: 'none', error: 'Cannot decrypt' },
  { status: 'unreadable', persistence: 'none', error: 'Permission denied' }
]

describe('unexpected sign-out auth evidence', () => {
  beforeEach(() => {
    readSession.mockReset()
    configuration.configured = true
  })

  it.each(absentSessions)('requires a preserved cloud link for $status credentials', (session) => {
    readSession.mockReturnValue(session)
    const linked = activeProfile(true)
    expect(getKinguProfileAuthStatusFromProfile(linked, '')).toMatchObject({
      state: 'reconnect-required',
      cloud: linked.profile.cloud,
      persistence: 'none',
      credentialError: 'error' in session ? session.error : undefined
    })
    readSession.mockClear()
    const signedOut = getKinguProfileAuthStatusFromProfile(activeProfile(false), '')
    expect(signedOut.state).toBe('local')
    expect(signedOut.cloud).toBeUndefined()
    expect(readSession).not.toHaveBeenCalled()
  })

  it.each(absentSessions)(
    'keeps unconfigured linked profiles out of reconnect for $status',
    (session) => {
      configuration.configured = false
      readSession.mockReturnValue(session)
      expect(getKinguProfileAuthStatusFromProfile(activeProfile(true), '').state).toBe(
        'unconfigured'
      )
      expect(getKinguProfileAuthStatusFromProfile(activeProfile(false), '').state).toBe(
        'unconfigured'
      )
    }
  )

  it('treats a live memory-only session as connected, then reconnects after its loss', () => {
    readSession.mockReturnValue({
      status: 'found',
      persistence: 'memory-only',
      session: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 60_000,
        capabilities: { flags: {}, refreshedAt: 0 }
      }
    })
    const linked = activeProfile(true)
    expect(getKinguProfileAuthStatusFromProfile(linked, '')).toMatchObject({
      state: 'connected',
      persistence: 'memory-only'
    })
    readSession.mockReturnValue({ status: 'missing', persistence: 'none' })
    expect(getKinguProfileAuthStatusFromProfile(linked, '').state).toBe('reconnect-required')
  })
})
