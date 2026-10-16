/**
 * Destination side of the migration blob channel. Blobs are not named by the signed manifest, so
 * a staged file's name carries its whole descriptor (`<key>.<sha256>.<byteLength>.part` under a
 * per-kind directory) and the staged set is read back from disk after a restart. At catalog commit
 * every staged blob must be complete and digest-exact, then moves to the migration's received
 * directory; installing received blobs into live state is each kind's installer (D1b-6b/6c).
 */
import { readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  KINGUD_MIGRATION_BLOB_KINDS,
  assertKingudMigrationBlobSet,
  decodeKingudMigrationBlobChunk,
  kingudMigrationBlobIdentity,
  parseKingudMigrationBlobDescriptor,
  sameKingudMigrationBlob,
  type KingudMigrationBlobChunkRequest,
  type KingudMigrationBlobChunkResult,
  type KingudMigrationBlobDescriptor,
  type KingudMigrationBlobKind,
  type KingudMigrationBlobUploadState
} from '../../../shared/kingud-migration-blob-transfer'
import type { KingudMigrationManifest } from '../../../shared/kingud-migration-manifest'
import { syncDirectoryDurablySync } from '../../durable-file-write'
import {
  appendKingudMigrationStagedChunk,
  ensureKingudMigrationDirectory,
  inspectKingudMigrationFinalFile,
  linkKingudMigrationStagedFile,
  kingudMigrationFileMatches,
  kingudMigrationStagedFileSize,
  kingudMigrationStagingDirectory,
  kingudMigrationStagingKey,
  pruneKingudMigrationKeyedDirectories,
  pruneKingudMigrationStagingDirectories,
  removeKingudMigrationStagingDirectory,
  requireStagedKingudMigrationManifest,
  type KingudMigrationRequestIdentity
} from './kingud-migration-staged-file'

const RECEIVED_DIRECTORY = 'received'
const STAGED_BLOB_NAME = /^([^.]+)\.([a-f0-9]{64})\.([1-9][0-9]*)\.part$/

type KingudMigrationBlobName = Pick<KingudMigrationBlobDescriptor, 'blobKind' | 'key'>

type ReceivedBlobPathResolver = (
  root: string,
  manifest: KingudMigrationRequestIdentity,
  descriptor: KingudMigrationBlobName
) => string

const receivedDirectoryPath: ReceivedBlobPathResolver = (root, manifest, descriptor) =>
  join(receivedBlobsDirectory(root, manifest), descriptor.blobKind, descriptor.key)

/** Where each kind lands at commit; every kind waits in the received directory for its installer. */
const RECEIVED_BLOB_DESTINATIONS: Record<KingudMigrationBlobKind, ReceivedBlobPathResolver> = {
  'terminal-restore-hints': receivedDirectoryPath,
  'shell-history': receivedDirectoryPath,
  'agent-session-records': receivedDirectoryPath
}

export function getKingudMigrationReceivedBlobPath(
  root: string,
  manifest: KingudMigrationRequestIdentity,
  descriptor: KingudMigrationBlobName
): string {
  return RECEIVED_BLOB_DESTINATIONS[descriptor.blobKind](root, manifest, descriptor)
}

/** Names in a committed migration's received directory for `blobKind`; the caller checks the key. */
export function listKingudMigrationReceivedBlobNames(
  root: string,
  manifest: KingudMigrationRequestIdentity,
  blobKind: KingudMigrationBlobKind
): string[] {
  return readDirectory(join(receivedBlobsDirectory(root, manifest), blobKind))
}

export type KingudMigrationBlobChunkStaging = {
  /** The manifest the importer holds staged for this migration, if any. */
  stagedManifest: KingudMigrationManifest | null
  root: string
  request: KingudMigrationBlobChunkRequest
}

export function stageKingudMigrationBlobChunk(
  args: KingudMigrationBlobChunkStaging
): KingudMigrationBlobChunkResult {
  const manifest = requireStagedKingudMigrationManifest(
    args.stagedManifest,
    args.request,
    'kingud_migration_blob_catalog_not_staged'
  )
  const descriptor = parseKingudMigrationBlobDescriptor(args.request.blob)
  const bytes = decodeKingudMigrationBlobChunk(args.request.bytesBase64)
  const staged = stagedBlobDescriptors(args.root, manifest)
  const existing = staged.find(
    (entry) => kingudMigrationBlobIdentity(entry) === kingudMigrationBlobIdentity(descriptor)
  )
  if (existing && !sameKingudMigrationBlob(existing, descriptor)) {
    // Never replace bytes already staged under this key; the sender aborts and restages instead.
    throw new Error(`kingud_migration_blob_descriptor_conflict:${descriptor.blobKind}`)
  }
  if (!existing) {
    assertKingudMigrationBlobSet([...staged, descriptor])
  }
  const path = stagedBlobPath(args.root, manifest, descriptor)
  ensureKingudMigrationDirectory(dirname(path))
  const receivedBytes = appendKingudMigrationStagedChunk({
    channel: 'blob',
    path,
    offset: args.request.offset,
    bytes,
    byteLength: descriptor.byteLength
  })
  return {
    migrationId: args.request.migrationId,
    manifestSha256: args.request.manifestSha256,
    blobKind: descriptor.blobKind,
    key: descriptor.key,
    receivedBytes
  }
}

export function inspectKingudMigrationBlobUploads(
  manifest: KingudMigrationManifest,
  root: string
): KingudMigrationBlobUploadState[] | undefined {
  const uploads = stagedBlobDescriptors(root, manifest).map((descriptor) => ({
    ...descriptor,
    receivedBytes:
      inspectReceivedBlob(root, manifest, descriptor) === 'matching'
        ? descriptor.byteLength
        : kingudMigrationStagedFileSize(
            stagedBlobPath(root, manifest, descriptor),
            descriptor.byteLength
          )
  }))
  return uploads.length > 0 ? uploads : undefined
}

export function assertKingudMigrationBlobsReady(
  manifest: KingudMigrationManifest,
  root: string
): void {
  for (const upload of inspectKingudMigrationBlobUploads(manifest, root) ?? []) {
    const label = `${upload.blobKind}:${upload.key}`
    const finalStatus = inspectReceivedBlob(root, manifest, upload)
    if (finalStatus === 'conflict') {
      throw new Error(`kingud_migration_blob_destination_conflict:${label}`)
    }
    if (upload.receivedBytes !== upload.byteLength) {
      throw new Error(`kingud_migration_blob_incomplete:${label}`)
    }
    if (
      finalStatus !== 'matching' &&
      !kingudMigrationFileMatches(stagedBlobPath(root, manifest, upload), upload)
    ) {
      throw new Error(`kingud_migration_blob_digest_mismatch:${label}`)
    }
  }
}

/**
 * Each still-staged blob's verified file; one an earlier attempt already moved was checked then.
 * Only meaningful after `assertKingudMigrationBlobsReady` in the same synchronous turn.
 */
export function stagedKingudMigrationBlobFiles(
  manifest: KingudMigrationManifest,
  root: string
): { descriptor: KingudMigrationBlobDescriptor; path: string }[] {
  return stagedBlobDescriptors(root, manifest).map((descriptor) => ({
    descriptor,
    path: stagedBlobPath(root, manifest, descriptor)
  }))
}

/**
 * Refuses commit unless the staged and already-received blobs are exactly the set the sender
 * moved, so a blob lost on the way (or left from another capture) fails instead of vanishing.
 */
export function assertKingudMigrationBlobSetMatches(
  manifest: KingudMigrationManifest,
  root: string,
  expected: readonly KingudMigrationBlobDescriptor[]
): void {
  assertKingudMigrationBlobSet(expected)
  const wanted = new Map(expected.map((entry) => [kingudMigrationBlobIdentity(entry), entry]))
  const staged = stagedBlobDescriptors(root, manifest)
  const stagedIds = new Set(staged.map(kingudMigrationBlobIdentity))
  for (const descriptor of staged) {
    const match = wanted.get(kingudMigrationBlobIdentity(descriptor))
    if (!match || !sameKingudMigrationBlob(match, descriptor)) {
      throw blobSetMismatch(descriptor)
    }
  }
  for (const identity of receivedBlobIdentities(root, manifest)) {
    if (!wanted.has(identity)) {
      throw new Error('kingud_migration_blob_set_mismatch')
    }
  }
  for (const descriptor of expected) {
    // An earlier commit attempt may already have moved it; the received bytes must still match.
    if (
      !stagedIds.has(kingudMigrationBlobIdentity(descriptor)) &&
      inspectReceivedBlob(root, manifest, descriptor) !== 'matching'
    ) {
      throw blobSetMismatch(descriptor)
    }
  }
}

/**
 * The caller must run `assertKingudMigrationBlobsReady` first, in the same synchronous turn: that
 * pass hashes every staged file, and no chunk can land between it and these links.
 */
export function commitKingudMigrationBlobs(manifest: KingudMigrationManifest, root: string): void {
  const directories = new Set<string>()
  for (const descriptor of stagedBlobDescriptors(root, manifest)) {
    const finalPath = getKingudMigrationReceivedBlobPath(root, manifest, descriptor)
    ensureKingudMigrationDirectory(dirname(finalPath))
    linkKingudMigrationStagedFile({
      stagedPath: stagedBlobPath(root, manifest, descriptor),
      finalPath,
      expected: descriptor,
      conflictError: `kingud_migration_blob_destination_conflict:${descriptor.blobKind}:${descriptor.key}`
    })
    directories.add(dirname(finalPath))
  }
  for (const directory of directories) {
    syncDirectoryDurablySync(directory)
  }
  removeKingudMigrationStagingDirectory(root, manifest)
}

/** Also drops blobs a failed commit already moved: the catalog they belonged to never landed. */
export function abortKingudMigrationBlobs(manifest: KingudMigrationManifest, root: string): void {
  removeKingudMigrationStagingDirectory(root, manifest)
  rmSync(receivedBlobsDirectory(root, manifest), { recursive: true, force: true })
}

/** Received blobs stay only for staged or committed migrations; a failed commit's are dropped. */
export function pruneKingudMigrationBlobStaging(
  stagedManifests: readonly KingudMigrationManifest[],
  committedMigrations: readonly KingudMigrationRequestIdentity[],
  root: string
): void {
  pruneKingudMigrationStagingDirectories(root, stagedManifests)
  pruneKingudMigrationKeyedDirectories(join(root, RECEIVED_DIRECTORY), [
    ...stagedManifests,
    ...committedMigrations
  ])
}

function blobSetMismatch(descriptor: KingudMigrationBlobDescriptor): Error {
  return new Error(`kingud_migration_blob_set_mismatch:${descriptor.blobKind}:${descriptor.key}`)
}

function receivedBlobIdentities(root: string, manifest: KingudMigrationManifest): string[] {
  const received = receivedBlobsDirectory(root, manifest)
  return KINGUD_MIGRATION_BLOB_KINDS.flatMap((blobKind) =>
    readDirectory(join(received, blobKind)).map((key) =>
      kingudMigrationBlobIdentity({ blobKind, key })
    )
  )
}

function stagedBlobDescriptors(
  root: string,
  manifest: KingudMigrationManifest
): KingudMigrationBlobDescriptor[] {
  const staging = kingudMigrationStagingDirectory(root, manifest)
  const descriptors: KingudMigrationBlobDescriptor[] = []
  for (const blobKind of KINGUD_MIGRATION_BLOB_KINDS) {
    for (const name of readDirectory(join(staging, blobKind))) {
      const match = STAGED_BLOB_NAME.exec(name)
      if (!match) {
        continue
      }
      try {
        descriptors.push(
          parseKingudMigrationBlobDescriptor({
            blobKind,
            key: match[1],
            sha256: match[2],
            byteLength: Number(match[3])
          })
        )
      } catch {
        // Not a name this channel writes; it cannot belong to the staged set.
      }
    }
  }
  return descriptors
}

function readDirectory(path: string): string[] {
  try {
    return readdirSync(path).sort()
  } catch {
    return []
  }
}

function inspectReceivedBlob(
  root: string,
  manifest: KingudMigrationManifest,
  descriptor: KingudMigrationBlobDescriptor
): 'absent' | 'matching' | 'conflict' {
  return inspectKingudMigrationFinalFile(
    getKingudMigrationReceivedBlobPath(root, manifest, descriptor),
    descriptor
  )
}

function receivedBlobsDirectory(root: string, manifest: KingudMigrationRequestIdentity): string {
  return join(root, RECEIVED_DIRECTORY, kingudMigrationStagingKey(manifest))
}

function stagedBlobPath(
  root: string,
  manifest: KingudMigrationManifest,
  descriptor: KingudMigrationBlobDescriptor
): string {
  return join(
    kingudMigrationStagingDirectory(root, manifest),
    descriptor.blobKind,
    `${descriptor.key}.${descriptor.sha256}.${descriptor.byteLength}.part`
  )
}
