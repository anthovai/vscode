import { z } from 'zod'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from './terminal-scrollback-limits'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import {
  assertUnique,
  boundedArray,
  requiredRecord,
  requiredString
} from './kingud-migration-dormant-value-validation'

export const MAX_KINGUD_MIGRATION_SCROLLBACK_SNAPSHOTS = 512
export const MAX_KINGUD_MIGRATION_SCROLLBACK_TOTAL_BYTES = 256 * 1024 * 1024
export const KINGUD_MIGRATION_SCROLLBACK_CHUNK_BYTES = 128 * 1024

export const KingudMigrationIdentitySchema = z.string().min(1).max(256)
export const KingudMigrationDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const SnapshotRef = z.string().regex(/^v1-[a-f0-9]{32}$/)
export const KingudMigrationChunkBase64Schema = z
  .string()
  .max(Math.ceil(KINGUD_MIGRATION_SCROLLBACK_CHUNK_BYTES / 3) * 4)
  .refine((value) => {
    try {
      return value.length > 0 && Buffer.from(value, 'base64').toString('base64') === value
    } catch {
      return false
    }
  })

export type KingudMigrationTerminalScrollbackSnapshot = {
  tabId: string
  leafId: string
  ref: string
  sha256: string
  byteLength: number
}

// Not strict: an older host must ignore optional fields a newer client adds.
export const KingudMigrationSnapshotChunkRequestSchema = z.object({
  migrationId: KingudMigrationIdentitySchema,
  manifestSha256: KingudMigrationDigestSchema,
  ref: SnapshotRef,
  offset: z.number().int().nonnegative().max(MAX_KINGUD_MIGRATION_SCROLLBACK_TOTAL_BYTES),
  bytesBase64: KingudMigrationChunkBase64Schema
})

export type KingudMigrationSnapshotChunkRequest = z.infer<
  typeof KingudMigrationSnapshotChunkRequestSchema
>

export type KingudMigrationSnapshotChunkResult = {
  migrationId: string
  manifestSha256: string
  ref: string
  acknowledgedOffset: number
}

export type KingudMigrationSnapshotUploadState = KingudMigrationTerminalScrollbackSnapshot & {
  receivedBytes: number
}

export function parseKingudMigrationSnapshotUploadStates(
  value: unknown,
  snapshots: readonly KingudMigrationTerminalScrollbackSnapshot[]
): KingudMigrationSnapshotUploadState[] | undefined {
  if (snapshots.length === 0) {
    return undefined
  }
  if (!Array.isArray(value) || value.length !== snapshots.length) {
    throw new Error('kingud_migration_snapshot_transfer_unsupported')
  }
  return snapshots.map((expected, index) => {
    const record = requiredRecord(value[index], 'kingud_migration_snapshot_state_invalid')
    if (
      record.tabId !== expected.tabId ||
      record.leafId !== expected.leafId ||
      record.ref !== expected.ref ||
      record.sha256 !== expected.sha256 ||
      record.byteLength !== expected.byteLength ||
      !Number.isSafeInteger(record.receivedBytes) ||
      Number(record.receivedBytes) < 0 ||
      Number(record.receivedBytes) > expected.byteLength
    ) {
      throw new Error('kingud_migration_snapshot_state_invalid')
    }
    return { ...expected, receivedBytes: Number(record.receivedBytes) }
  })
}

export function parseKingudMigrationSnapshotChunkResult(
  value: unknown,
  request: KingudMigrationSnapshotChunkRequest
): KingudMigrationSnapshotChunkResult {
  const record = requiredRecord(value, 'kingud_migration_snapshot_chunk_result_invalid')
  const acknowledgedOffset =
    request.offset + decodeKingudMigrationSnapshotChunk(request.bytesBase64).length
  if (
    record.migrationId !== request.migrationId ||
    record.manifestSha256 !== request.manifestSha256 ||
    record.ref !== request.ref ||
    !Number.isSafeInteger(record.acknowledgedOffset) ||
    Number(record.acknowledgedOffset) !== acknowledgedOffset
  ) {
    throw new Error('kingud_migration_snapshot_chunk_result_invalid')
  }
  return {
    migrationId: request.migrationId,
    manifestSha256: request.manifestSha256,
    ref: request.ref,
    acknowledgedOffset
  }
}

export function parseKingudMigrationTerminalScrollbackSnapshots(
  value: unknown
): KingudMigrationTerminalScrollbackSnapshot[] {
  const snapshots = boundedArray(
    value,
    parseSnapshot,
    'scrollback_snapshots',
    MAX_KINGUD_MIGRATION_SCROLLBACK_SNAPSHOTS
  )
  assertUnique(snapshots, (entry) => entry.ref, 'scrollback_snapshot_ref')
  assertUnique(snapshots, (entry) => `${entry.tabId}\0${entry.leafId}`, 'scrollback_snapshot_leaf')
  if (
    snapshots.reduce((total, entry) => total + entry.byteLength, 0) >
    MAX_KINGUD_MIGRATION_SCROLLBACK_TOTAL_BYTES
  ) {
    throw new Error('kingud_migration_dormant_scrollback_snapshots_too_large')
  }
  return snapshots
}

export function assertKingudMigrationScrollbackReferences(
  session: WorkspaceSessionState | undefined,
  snapshots: readonly KingudMigrationTerminalScrollbackSnapshot[]
): void {
  const expected = new Map(snapshots.map((entry) => [`${entry.tabId}\0${entry.leafId}`, entry]))
  let referenceCount = 0
  for (const [tabId, layout] of Object.entries(session?.terminalLayoutsByTabId ?? {})) {
    for (const [leafId, ref] of Object.entries(layout.scrollbackRefsByLeafId ?? {})) {
      const descriptor = expected.get(`${tabId}\0${leafId}`)
      if (!descriptor || descriptor.ref !== ref) {
        throw new Error('kingud_migration_dormant_scrollback_reference_invalid')
      }
      referenceCount += 1
    }
  }
  if (referenceCount !== snapshots.length) {
    throw new Error('kingud_migration_dormant_scrollback_reference_invalid')
  }
}

export function decodeKingudMigrationSnapshotChunk(bytesBase64: string): Buffer {
  return decodeKingudMigrationChunk(bytesBase64, 'kingud_migration_snapshot_chunk_invalid')
}

/** One canonical, non-empty chunk of at most the shared transfer size; `error` names the channel. */
export function decodeKingudMigrationChunk(bytesBase64: string, error: string): Buffer {
  const bytes = Buffer.from(bytesBase64, 'base64')
  if (
    bytes.length === 0 ||
    bytes.length > KINGUD_MIGRATION_SCROLLBACK_CHUNK_BYTES ||
    bytes.toString('base64') !== bytesBase64
  ) {
    throw new Error(error)
  }
  return bytes
}

function parseSnapshot(value: unknown): KingudMigrationTerminalScrollbackSnapshot {
  const record = requiredRecord(value, 'kingud_migration_dormant_scrollback_snapshot_invalid')
  const ref = requiredString(record.ref, 'kingud_migration_dormant_scrollback_ref_invalid')
  const sha256 = requiredString(record.sha256, 'kingud_migration_dormant_scrollback_digest_invalid')
  if (
    !SnapshotRef.safeParse(ref).success ||
    !KingudMigrationDigestSchema.safeParse(sha256).success
  ) {
    throw new Error('kingud_migration_dormant_scrollback_identity_invalid')
  }
  if (
    !Number.isSafeInteger(record.byteLength) ||
    Number(record.byteLength) < 1 ||
    Number(record.byteLength) > TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT
  ) {
    throw new Error('kingud_migration_dormant_scrollback_size_invalid')
  }
  return {
    tabId: requiredString(record.tabId, 'kingud_migration_dormant_scrollback_tab_invalid'),
    leafId: requiredString(record.leafId, 'kingud_migration_dormant_scrollback_leaf_invalid'),
    ref,
    sha256,
    byteLength: Number(record.byteLength)
  }
}
