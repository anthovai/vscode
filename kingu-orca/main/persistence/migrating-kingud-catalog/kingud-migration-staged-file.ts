/**
 * The destination's resumable staging files, shared by scrollback snapshots and migration blobs:
 * fsync'd appends whose retried ranges must match, size-as-progress, digest-checked hard-link
 * commits, and per-migration staging directories that abort and prune remove whole.
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import type { KingudMigrationManifest } from '../../../shared/kingud-migration-manifest'
import { syncDirectoryDurablySync } from '../../durable-file-write'

export const KINGUD_MIGRATION_STAGING_DIRECTORY = '.kingud-migration-staging'

/** Names the error codes, e.g. `kingud_migration_<channel>_offset_invalid`. */
export type KingudMigrationStagingChannel = 'snapshot' | 'blob'

export type KingudMigrationRequestIdentity = { migrationId: string; manifestSha256: string }

export type KingudMigrationStagedContent = { sha256: string; byteLength: number }

export type KingudMigrationStagedChunk = {
  channel: KingudMigrationStagingChannel
  path: string
  offset: number
  bytes: Buffer
  byteLength: number
}

/** Appends one chunk, or confirms an identical retry; returns the staged size afterwards. */
export function appendKingudMigrationStagedChunk(chunk: KingudMigrationStagedChunk): number {
  const { channel, path, offset, bytes } = chunk
  const descriptorFd = openStagedFile(path)
  try {
    const size = statSync(path).size
    if (offset > size || offset + bytes.length > chunk.byteLength) {
      throw new Error(`kingud_migration_${channel}_offset_invalid`)
    }
    if (offset < size) {
      if (offset + bytes.length > size) {
        throw new Error(`kingud_migration_${channel}_offset_invalid`)
      }
      const existing = Buffer.alloc(bytes.length)
      const read = readSync(descriptorFd, existing, 0, existing.length, offset)
      if (read !== bytes.length || !existing.equals(bytes)) {
        throw new Error(`kingud_migration_${channel}_retry_mismatch`)
      }
      return size
    }
    const written = writeSync(descriptorFd, bytes, 0, bytes.length, offset)
    if (written !== bytes.length) {
      throw new Error(`kingud_migration_${channel}_write_incomplete`)
    }
    fsyncSync(descriptorFd)
    return size + bytes.length
  } finally {
    closeSync(descriptorFd)
  }
}

export function kingudMigrationStagedFileSize(path: string, byteLength: number): number {
  try {
    return Math.min(statSync(path).size, byteLength)
  } catch {
    return 0
  }
}

export function kingudMigrationFileMatches(
  path: string,
  expected: KingudMigrationStagedContent
): boolean {
  try {
    const bytes = readFileSync(path)
    return (
      bytes.length === expected.byteLength &&
      createHash('sha256').update(bytes).digest('hex') === expected.sha256
    )
  } catch {
    return false
  }
}

export function inspectKingudMigrationFinalFile(
  path: string | null,
  expected: KingudMigrationStagedContent
): 'absent' | 'matching' | 'conflict' {
  if (!path || !existsSync(path)) {
    return 'absent'
  }
  return kingudMigrationFileMatches(path, expected) ? 'matching' : 'conflict'
}

/**
 * Hard-links a verified staged file into place, then drops the staged name. A final file that
 * already holds the same bytes (an earlier commit attempt) counts as done; different bytes refuse.
 */
export function linkKingudMigrationStagedFile(args: {
  stagedPath: string
  finalPath: string
  expected: KingudMigrationStagedContent
  conflictError: string
}): void {
  if (inspectKingudMigrationFinalFile(args.finalPath, args.expected) !== 'matching') {
    try {
      linkSync(args.stagedPath, args.finalPath)
    } catch (error) {
      const finalStatus = inspectKingudMigrationFinalFile(args.finalPath, args.expected)
      if (finalStatus === 'conflict') {
        throw new Error(args.conflictError)
      }
      if (finalStatus !== 'matching') {
        throw error
      }
    }
  }
  rmSync(args.stagedPath, { force: true })
}

export function kingudMigrationStagingDirectory(
  root: string,
  manifest: KingudMigrationManifest
): string {
  return join(root, KINGUD_MIGRATION_STAGING_DIRECTORY, kingudMigrationStagingKey(manifest))
}

export function ensureKingudMigrationDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

export function removeKingudMigrationStagingDirectory(
  root: string,
  manifest: KingudMigrationManifest
): void {
  rmSync(kingudMigrationStagingDirectory(root, manifest), { recursive: true, force: true })
  syncDirectoryDurablySync(join(root, KINGUD_MIGRATION_STAGING_DIRECTORY))
}

/** Removes staging for every migration the importer no longer holds staged. */
export function pruneKingudMigrationStagingDirectories(
  root: string,
  stagedManifests: readonly KingudMigrationManifest[]
): void {
  pruneKingudMigrationKeyedDirectories(
    join(root, KINGUD_MIGRATION_STAGING_DIRECTORY),
    stagedManifests
  )
}

/** Removes every per-migration directory under `parent` whose migration is not retained. */
export function pruneKingudMigrationKeyedDirectories(
  parent: string,
  retainedMigrations: readonly KingudMigrationRequestIdentity[]
): void {
  const retained = new Set(retainedMigrations.map(kingudMigrationStagingKey))
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return
  }
  for (const entry of entries) {
    if (/^[a-f0-9]{32}$/.test(entry) && !retained.has(entry)) {
      rmSync(join(parent, entry), { recursive: true, force: true })
    }
  }
}

/** The importer's staged manifest for this request, or the channel's own refusal. */
export function requireStagedKingudMigrationManifest(
  staged: KingudMigrationManifest | null,
  request: KingudMigrationRequestIdentity,
  notStagedError: string
): KingudMigrationManifest {
  if (
    !staged ||
    staged.migrationId !== request.migrationId ||
    staged.manifestSha256 !== request.manifestSha256
  ) {
    throw new Error(notStagedError)
  }
  return staged
}

export function kingudMigrationStagingKey(manifest: KingudMigrationRequestIdentity): string {
  return createHash('sha256')
    .update(`${manifest.migrationId}\0${manifest.manifestSha256}`)
    .digest('hex')
    .slice(0, 32)
}

function openStagedFile(path: string): number {
  try {
    return openSync(path, 'r+')
  } catch {
    try {
      return openSync(path, 'wx+', 0o600)
    } catch {
      return openSync(path, 'r+')
    }
  }
}
