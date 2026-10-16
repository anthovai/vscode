import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { KingudMigrationManifest } from '../../../shared/kingud-migration-manifest'
import {
  decodeKingudMigrationSnapshotChunk,
  type KingudMigrationSnapshotChunkRequest,
  type KingudMigrationSnapshotChunkResult,
  type KingudMigrationSnapshotUploadState,
  type KingudMigrationTerminalScrollbackSnapshot
} from '../../../shared/kingud-migration-scrollback'
import { syncDirectoryDurablySync } from '../../durable-file-write'
import {
  getTerminalScrollbackSnapshotPath,
  getTerminalScrollbackSnapshotRoot,
  type TerminalScrollbackSnapshotStorage
} from '../../terminal-scrollback-snapshots'
import {
  appendKingudMigrationStagedChunk,
  ensureKingudMigrationDirectory,
  inspectKingudMigrationFinalFile,
  linkKingudMigrationStagedFile,
  kingudMigrationFileMatches,
  kingudMigrationStagedFileSize,
  kingudMigrationStagingDirectory,
  pruneKingudMigrationStagingDirectories,
  removeKingudMigrationStagingDirectory,
  requireStagedKingudMigrationManifest
} from './kingud-migration-staged-file'

/**
 * Destination side: append one verified chunk to the staging file for a snapshot the staged
 * manifest names. `stagedManifest` is the manifest the importer accepted; a request for any
 * other migration or digest is refused. Retries of an already-written range must match it.
 */
export function stageKingudMigrationSnapshotChunk(args: {
  stagedManifest: KingudMigrationManifest | null
  storage: TerminalScrollbackSnapshotStorage
  request: KingudMigrationSnapshotChunkRequest
}): KingudMigrationSnapshotChunkResult {
  const manifest = requireStagedKingudMigrationManifest(
    args.stagedManifest,
    args.request,
    'kingud_migration_snapshot_catalog_not_staged'
  )
  const descriptor = requireDescriptor(manifest, args.request.ref)
  const bytes = decodeKingudMigrationSnapshotChunk(args.request.bytesBase64)
  ensureKingudMigrationDirectory(stagingDirectory(args.storage, manifest))
  const acknowledgedOffset = appendKingudMigrationStagedChunk({
    channel: 'snapshot',
    path: stagedSnapshotPath(args.storage, manifest, descriptor),
    offset: args.request.offset,
    bytes,
    byteLength: descriptor.byteLength
  })
  return {
    migrationId: args.request.migrationId,
    manifestSha256: args.request.manifestSha256,
    ref: args.request.ref,
    acknowledgedOffset
  }
}

export function inspectKingudMigrationSnapshotUploads(
  manifest: KingudMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): KingudMigrationSnapshotUploadState[] | undefined {
  const snapshots = manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
  if (snapshots.length === 0) {
    return undefined
  }
  return snapshots.map((descriptor) => ({
    ...descriptor,
    receivedBytes:
      inspectFinalSnapshot(storage, descriptor) === 'matching'
        ? descriptor.byteLength
        : kingudMigrationStagedFileSize(
            stagedSnapshotPath(storage, manifest, descriptor),
            descriptor.byteLength
          )
  }))
}

export function assertKingudMigrationSnapshotsReady(
  manifest: KingudMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): void {
  for (const upload of inspectKingudMigrationSnapshotUploads(manifest, storage) ?? []) {
    const finalStatus = inspectFinalSnapshot(storage, upload)
    if (finalStatus === 'conflict') {
      throw new Error(`kingud_migration_snapshot_destination_conflict:${upload.ref}`)
    }
    if (upload.receivedBytes !== upload.byteLength) {
      throw new Error(`kingud_migration_snapshot_incomplete:${upload.ref}`)
    }
    const path =
      finalStatus === 'matching'
        ? getTerminalScrollbackSnapshotPath(upload.ref, storage)
        : stagedSnapshotPath(storage, manifest, upload)
    if (!path || !kingudMigrationFileMatches(path, upload)) {
      throw new Error(`kingud_migration_snapshot_digest_mismatch:${upload.ref}`)
    }
  }
}

export function commitKingudMigrationSnapshots(
  manifest: KingudMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): void {
  const snapshots = manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
  assertKingudMigrationSnapshotsReady(manifest, storage)
  const root = getTerminalScrollbackSnapshotRoot(storage)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const descriptor of snapshots) {
    const finalPath = getTerminalScrollbackSnapshotPath(descriptor.ref, storage)
    if (!finalPath) {
      throw new Error('kingud_migration_snapshot_ref_invalid')
    }
    linkKingudMigrationStagedFile({
      stagedPath: stagedSnapshotPath(storage, manifest, descriptor),
      finalPath,
      expected: descriptor,
      conflictError: `kingud_migration_snapshot_destination_conflict:${descriptor.ref}`
    })
  }
  syncDirectoryDurablySync(root)
  removeKingudMigrationStagingDirectory(root, manifest)
}

export function abortKingudMigrationSnapshots(
  manifest: KingudMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): void {
  removeKingudMigrationStagingDirectory(getTerminalScrollbackSnapshotRoot(storage), manifest)
}

/** Removes staging for every migration the importer no longer holds staged. */
export function pruneKingudMigrationSnapshotStaging(
  stagedManifests: readonly KingudMigrationManifest[],
  storage: TerminalScrollbackSnapshotStorage
): void {
  pruneKingudMigrationStagingDirectories(
    getTerminalScrollbackSnapshotRoot(storage),
    stagedManifests
  )
}

function requireDescriptor(
  manifest: KingudMigrationManifest,
  ref: string
): KingudMigrationTerminalScrollbackSnapshot {
  const descriptor = manifest.payload.dormantState?.terminalScrollbackSnapshots?.find(
    (entry) => entry.ref === ref
  )
  if (!descriptor) {
    throw new Error('kingud_migration_snapshot_unknown')
  }
  return descriptor
}

function inspectFinalSnapshot(
  storage: TerminalScrollbackSnapshotStorage,
  descriptor: KingudMigrationTerminalScrollbackSnapshot
): 'absent' | 'matching' | 'conflict' {
  return inspectKingudMigrationFinalFile(
    getTerminalScrollbackSnapshotPath(descriptor.ref, storage),
    descriptor
  )
}

function stagingDirectory(
  storage: TerminalScrollbackSnapshotStorage,
  manifest: KingudMigrationManifest
): string {
  return kingudMigrationStagingDirectory(getTerminalScrollbackSnapshotRoot(storage), manifest)
}

function stagedSnapshotPath(
  storage: TerminalScrollbackSnapshotStorage,
  manifest: KingudMigrationManifest,
  descriptor: KingudMigrationTerminalScrollbackSnapshot
): string {
  return join(stagingDirectory(storage, manifest), `${descriptor.ref}.${descriptor.sha256}.part`)
}
