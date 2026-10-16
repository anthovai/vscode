import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { guardedSafeStorage as safeStorage } from '../host/safe-storage-availability'
import { isUnreadableError, writeSecureJsonFile } from '../../shared/secure-file'
import type {
  KinguCloudCapabilities,
  KinguCloudOrgSummary,
  KinguCloudSessionPersistence
} from '../../shared/kingu-profiles'
import { getKinguProfileDirectory } from './profile-storage-paths'
import { allowsPlaintextKinguCloudSession } from './profile-cloud-auth-config'

export type KinguCloudSession = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  capabilities: KinguCloudCapabilities
  organizations?: KinguCloudOrgSummary[]
}

export type KinguCloudSessionReadResult =
  | { status: 'found'; session: KinguCloudSession; persistence: KinguCloudSessionPersistence }
  | { status: 'missing'; persistence: 'none' }
  | { status: 'decrypt-failed'; persistence: 'none'; error: string }
  /**
   * The file is there and this process may not read it. Distinct from `decrypt-failed` because
   * that one means "read it, it was garbage" and licenses replacing it; this one licenses nothing.
   */
  | { status: 'unreadable'; persistence: 'none'; error: string }

type PersistedEncryptedSession = {
  version: 1
  format: 'electron-safe-storage-v1'
  savedAt: number
  ciphertext: string
}

type PersistedPlaintextSession = {
  version: 1
  format: 'dev-plaintext-v1'
  savedAt: number
  session: KinguCloudSession
}

type CachedKinguCloudSession = {
  session: KinguCloudSession
  persistence: Exclude<KinguCloudSessionPersistence, 'none'>
}

const memorySessions = new Map<string, CachedKinguCloudSession>()
export const MAX_MEMORY_CLOUD_SESSIONS = 64

function rememberMemorySession(key: string, session: CachedKinguCloudSession): void {
  memorySessions.delete(key)
  memorySessions.set(key, session)
  while (memorySessions.size > MAX_MEMORY_CLOUD_SESSIONS) {
    const oldest = memorySessions.keys().next()
    if (oldest.done || oldest.value === key) {
      break
    }
    memorySessions.delete(oldest.value)
  }
}

export function kinguCloudSessionKey(profileId: string, userDataPath: string): string {
  return `${userDataPath}\0${profileId}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKinguCloudSession(value: unknown): value is KinguCloudSession {
  if (!isObject(value) || !isObject(value.capabilities) || !isObject(value.capabilities.flags)) {
    return false
  }
  if (value.organizations !== undefined && !isKinguCloudOrganizations(value.organizations)) {
    return false
  }
  return (
    typeof value.accessToken === 'string' &&
    value.accessToken.length > 0 &&
    typeof value.refreshToken === 'string' &&
    value.refreshToken.length > 0 &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    typeof value.capabilities.refreshedAt === 'number' &&
    Number.isFinite(value.capabilities.refreshedAt)
  )
}

function isKinguCloudOrganizations(value: unknown): value is KinguCloudOrgSummary[] {
  if (!Array.isArray(value)) {
    return false
  }
  return value.every((organization) => {
    if (!isObject(organization)) {
      return false
    }
    return (
      typeof organization.orgId === 'string' &&
      organization.orgId.length > 0 &&
      typeof organization.name === 'string' &&
      organization.name.length > 0 &&
      (organization.role === undefined || typeof organization.role === 'string')
    )
  })
}

export function getKinguCloudSessionPath(profileId: string, userDataPath: string): string {
  return join(getKinguProfileDirectory(profileId, userDataPath), 'account-session.json.enc')
}

// Rotated sessions whose write failed. The token on disk is already spent, so each is retried
// on the next read and at quit until it lands or the session changes.
const unsavedRotations = new Map<
  string,
  { profileId: string; userDataPath: string; session: KinguCloudSession }
>()

function writeKinguCloudSession(
  profileId: string,
  userDataPath: string,
  session: KinguCloudSession
): KinguCloudSessionPersistence {
  const cacheKey = kinguCloudSessionKey(profileId, userDataPath)
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted: PersistedEncryptedSession = {
      version: 1,
      format: 'electron-safe-storage-v1',
      savedAt: Date.now(),
      ciphertext: safeStorage.encryptString(JSON.stringify(session)).toString('base64')
    }
    writeSecureJsonFile(getKinguCloudSessionPath(profileId, userDataPath), encrypted)
    rememberMemorySession(cacheKey, { session, persistence: 'encrypted' })
    return 'encrypted'
  }

  if (allowsPlaintextKinguCloudSession()) {
    const plaintext: PersistedPlaintextSession = {
      version: 1,
      format: 'dev-plaintext-v1',
      savedAt: Date.now(),
      session
    }
    writeSecureJsonFile(getKinguCloudSessionPath(profileId, userDataPath), plaintext)
    rememberMemorySession(cacheKey, { session, persistence: 'dev-plaintext' })
    return 'dev-plaintext'
  }

  // Why: Kingu account refresh tokens must not silently fall back to plaintext
  // in production. Memory-only keeps cloud features usable until restart.
  rememberMemorySession(cacheKey, { session, persistence: 'memory-only' })
  return 'memory-only'
}

export function saveKinguCloudSession(
  profileId: string,
  userDataPath: string,
  session: KinguCloudSession,
  options: { spentOnFailure?: boolean } = {}
): KinguCloudSessionPersistence {
  const key = kinguCloudSessionKey(profileId, userDataPath)
  try {
    const persistence = writeKinguCloudSession(profileId, userDataPath, session)
    unsavedRotations.delete(key)
    return persistence
  } catch (error) {
    // A failed non-rotating write throws as before and leaves any unsaved rotation pending.
    if (!options.spentOnFailure) {
      throw error
    }
    // Why: losing a rotated token makes the next refresh resend the spent one, which the
    // server reads as reuse and revokes the whole family.
    unsavedRotations.set(key, { profileId, userDataPath, session })
    try {
      rmSync(getKinguCloudSessionPath(profileId, userDataPath), { force: true })
    } catch {
      // A spent token left on disk costs one sign-in after restart, never a loop.
    }
    return 'memory-only'
  }
}

function retryUnsavedRotation(key: string): void {
  const unsaved = unsavedRotations.get(key)
  if (!unsaved) {
    return
  }
  try {
    writeKinguCloudSession(unsaved.profileId, unsaved.userDataPath, unsaved.session)
    unsavedRotations.delete(key)
  } catch {
    // Still unsaved; the next read or the quit flush tries again.
  }
}

export function flushUnsavedKinguCloudSessions(): void {
  for (const key of unsavedRotations.keys()) {
    retryUnsavedRotation(key)
  }
}

export function readKinguCloudSession(
  profileId: string,
  userDataPath: string
): KinguCloudSessionReadResult {
  const cacheKey = kinguCloudSessionKey(profileId, userDataPath)
  retryUnsavedRotation(cacheKey)
  const unsaved = unsavedRotations.get(cacheKey)
  if (unsaved) {
    return { status: 'found', session: unsaved.session, persistence: 'memory-only' }
  }
  const memorySession = memorySessions.get(cacheKey)
  if (memorySession) {
    memorySessions.delete(cacheKey)
    memorySessions.set(cacheKey, memorySession)
    return {
      status: 'found',
      session: memorySession.session,
      persistence: memorySession.persistence
    }
  }

  const path = getKinguCloudSessionPath(profileId, userDataPath)
  if (!existsSync(path)) {
    return { status: 'missing', persistence: 'none' }
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as
      | PersistedEncryptedSession
      | PersistedPlaintextSession
    if (parsed.version !== 1) {
      return { status: 'decrypt-failed', persistence: 'none', error: 'Unsupported session format.' }
    }
    if (parsed.format === 'electron-safe-storage-v1') {
      if (!safeStorage.isEncryptionAvailable()) {
        return {
          status: 'decrypt-failed',
          persistence: 'none',
          error: 'OS-backed encryption is unavailable.'
        }
      }
      const decrypted = safeStorage.decryptString(Buffer.from(parsed.ciphertext, 'base64'))
      const session = JSON.parse(decrypted) as KinguCloudSession
      if (!isKinguCloudSession(session)) {
        return { status: 'decrypt-failed', persistence: 'none', error: 'Invalid saved session.' }
      }
      rememberMemorySession(cacheKey, { session, persistence: 'encrypted' })
      return { status: 'found', session, persistence: 'encrypted' }
    }
    if (parsed.format === 'dev-plaintext-v1' && allowsPlaintextKinguCloudSession()) {
      if (!isKinguCloudSession(parsed.session)) {
        return { status: 'decrypt-failed', persistence: 'none', error: 'Invalid saved session.' }
      }
      rememberMemorySession(cacheKey, { session: parsed.session, persistence: 'dev-plaintext' })
      return { status: 'found', session: parsed.session, persistence: 'dev-plaintext' }
    }
    return { status: 'decrypt-failed', persistence: 'none', error: 'Unsafe session format.' }
  } catch (error) {
    if (isUnreadableError(error)) {
      return {
        status: 'unreadable',
        persistence: 'none',
        error: 'Cannot read the saved Kingu account session: the read failed.'
      }
    }
    return {
      status: 'decrypt-failed',
      persistence: 'none',
      error: 'Could not decrypt saved Kingu account session.'
    }
  }
}

export function clearKinguCloudSession(profileId: string, userDataPath: string): void {
  const key = kinguCloudSessionKey(profileId, userDataPath)
  unsavedRotations.delete(key)
  memorySessions.delete(key)
  rmSync(getKinguCloudSessionPath(profileId, userDataPath), { force: true })
}

export function getKinguCloudMemorySessionCountForTests(): number {
  return memorySessions.size
}
