/**
 * Sending a manifest's scrollback snapshots to the destination in bounded, resumable chunks.
 *
 * The source side only reads: each chunk comes from the profile-state store, checked against the
 * signed manifest's length and digest. The destination's catalog operations are passed in, so
 * this driver owns no transport and retires nothing. A chunk whose acknowledgement was lost is
 * confirmed by reading the destination's recorded offset, never assumed.
 */
import type {
  KingudMigrationCatalogState,
  KingudMigrationManifest
} from '../../shared/kingud-migration-manifest'
import {
  decodeKingudMigrationSnapshotChunk,
  type KingudMigrationSnapshotChunkRequest,
  type KingudMigrationSnapshotChunkResult
} from '../../shared/kingud-migration-scrollback'
import type { Store } from '../persistence'

export type KingudMigrationSnapshotSource = Pick<Store, 'readKingudMigrationSourceSnapshotChunk'>

export type KingudMigrationSnapshotDestination = {
  readState: (manifest: KingudMigrationManifest) => Promise<KingudMigrationCatalogState>
  stageChunk: (
    request: KingudMigrationSnapshotChunkRequest
  ) => Promise<KingudMigrationSnapshotChunkResult>
}

export async function transferKingudMigrationSnapshots(args: {
  source: KingudMigrationSnapshotSource
  manifest: KingudMigrationManifest
  /** The destination's staged state, whose upload offsets say where each snapshot resumes. */
  state: Extract<KingudMigrationCatalogState, { state: 'staged' }>
  destination: KingudMigrationSnapshotDestination
}): Promise<void> {
  const snapshots = args.manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
  if (snapshots.length === 0) {
    return
  }
  // The journal holds these bytes until commit or abort, so a closed tab still sends on a retry.
  await sendSnapshots(args, snapshots)
}

async function sendSnapshots(
  args: Parameters<typeof transferKingudMigrationSnapshots>[0],
  snapshots: NonNullable<
    NonNullable<KingudMigrationManifest['payload']['dormantState']>['terminalScrollbackSnapshots']
  >
): Promise<void> {
  const offsets = new Map(
    (args.state.snapshotUploads ?? []).map((entry) => [entry.ref, entry.receivedBytes])
  )
  for (const snapshot of snapshots) {
    let offset = offsets.get(snapshot.ref)
    if (offset === undefined) {
      throw new Error('kingud_migration_snapshot_transfer_unsupported')
    }
    while (offset < snapshot.byteLength) {
      const chunk = args.source.readKingudMigrationSourceSnapshotChunk(
        args.manifest,
        snapshot.ref,
        offset
      )
      if (chunk.totalBytes !== snapshot.byteLength || !chunk.bytesBase64) {
        throw new Error('kingud_migration_source_snapshot_changed')
      }
      const request: KingudMigrationSnapshotChunkRequest = {
        migrationId: args.manifest.migrationId,
        manifestSha256: args.manifest.manifestSha256,
        ref: snapshot.ref,
        offset,
        bytesBase64: chunk.bytesBase64
      }
      const expectedOffset = offset + decodeKingudMigrationSnapshotChunk(chunk.bytesBase64).length
      offset = await stageChunkWithRecovery(args, request, expectedOffset)
    }
  }
  const verified = await args.destination.readState(args.manifest)
  if (
    verified.state !== 'staged' ||
    (verified.snapshotUploads ?? []).length !== snapshots.length ||
    (verified.snapshotUploads ?? []).some((entry) => entry.receivedBytes !== entry.byteLength)
  ) {
    throw new Error('kingud_migration_snapshot_transfer_incomplete')
  }
}

async function stageChunkWithRecovery(
  args: { manifest: KingudMigrationManifest; destination: KingudMigrationSnapshotDestination },
  request: KingudMigrationSnapshotChunkRequest,
  expectedOffset: number
): Promise<number> {
  try {
    const result = await args.destination.stageChunk(request)
    if (result.acknowledgedOffset !== expectedOffset) {
      throw new Error('kingud_migration_snapshot_ack_invalid')
    }
    return result.acknowledgedOffset
  } catch (error) {
    try {
      const observed = await args.destination.readState(args.manifest)
      const received =
        observed.state === 'staged'
          ? observed.snapshotUploads?.find((entry) => entry.ref === request.ref)?.receivedBytes
          : undefined
      if (received === expectedOffset) {
        return received
      }
    } catch {
      // The chunk stays unverifiable; report the first failure.
    }
    throw error
  }
}
