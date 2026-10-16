/**
 * Sending a migration's blobs to the destination in bounded, resumable chunks, beside the
 * manifest's scrollback snapshots. Every kind is checked against the destination's capabilities
 * before the first byte: a kind it cannot install is refused by name, never dropped. Offsets
 * resume from the destination's staged state, and a lost acknowledgement is confirmed by
 * re-reading that state, never assumed.
 */
import {
  KINGUD_MIGRATION_BLOB_CHUNK_BYTES,
  type KingudMigrationBlobChunkRequest,
  type KingudMigrationBlobChunkResult,
  type KingudMigrationBlobDescriptor,
  assertKingudMigrationBlobSet,
  findUnsupportedMigrationBlobKind,
  kingudMigrationBlobIdentity,
  kingudMigrationBlobKindUnsupportedBlocker,
  sameKingudMigrationBlob
} from '../../shared/kingud-migration-blob-transfer'
import type {
  KingudMigrationCatalogState,
  KingudMigrationManifest
} from '../../shared/kingud-migration-manifest'

export type KingudMigrationBlobSource = {
  /** Up to `maxBytes` bytes of the blob starting at `offset`, exactly as the descriptor hashed. */
  readChunk: (
    descriptor: KingudMigrationBlobDescriptor,
    offset: number,
    maxBytes: number
  ) => Promise<Buffer>
}

export type KingudMigrationBlobDestination = {
  readCapabilities: () => Promise<readonly string[]>
  readState: (manifest: KingudMigrationManifest) => Promise<KingudMigrationCatalogState>
  stageChunk: (request: KingudMigrationBlobChunkRequest) => Promise<KingudMigrationBlobChunkResult>
}

export type KingudMigrationBlobTransfer = {
  source: KingudMigrationBlobSource
  manifest: KingudMigrationManifest
  blobs: readonly KingudMigrationBlobDescriptor[]
  destination: KingudMigrationBlobDestination
}

type StagedCatalogState = Extract<KingudMigrationCatalogState, { state: 'staged' }>

export async function transferKingudMigrationBlobs(
  transfer: KingudMigrationBlobTransfer
): Promise<void> {
  if (transfer.blobs.length === 0) {
    return
  }
  assertKingudMigrationBlobSet(transfer.blobs)
  const unsupported = findUnsupportedMigrationBlobKind(
    transfer.blobs,
    await transfer.destination.readCapabilities()
  )
  if (unsupported) {
    throw new Error(kingudMigrationBlobKindUnsupportedBlocker(unsupported))
  }
  const offsets = receivedOffsets(transfer, await readStagedState(transfer))
  for (const blob of transfer.blobs) {
    let offset = offsets.get(kingudMigrationBlobIdentity(blob)) ?? 0
    while (offset < blob.byteLength) {
      const bytes = await transfer.source.readChunk(
        blob,
        offset,
        Math.min(KINGUD_MIGRATION_BLOB_CHUNK_BYTES, blob.byteLength - offset)
      )
      if (
        bytes.length === 0 ||
        bytes.length > KINGUD_MIGRATION_BLOB_CHUNK_BYTES ||
        offset + bytes.length > blob.byteLength
      ) {
        throw new Error(`kingud_migration_source_blob_changed:${blob.blobKind}`)
      }
      const request: KingudMigrationBlobChunkRequest = {
        migrationId: transfer.manifest.migrationId,
        manifestSha256: transfer.manifest.manifestSha256,
        blob: { ...blob },
        offset,
        bytesBase64: bytes.toString('base64')
      }
      offset = await stageChunkWithRecovery(transfer, request, offset + bytes.length)
    }
  }
  assertAllReceived(transfer, await readStagedState(transfer))
}

async function readStagedState(transfer: KingudMigrationBlobTransfer): Promise<StagedCatalogState> {
  const state = await transfer.destination.readState(transfer.manifest)
  if (state.state !== 'staged') {
    throw new Error('kingud_migration_blob_catalog_not_staged')
  }
  return state
}

function receivedOffsets(
  transfer: KingudMigrationBlobTransfer,
  state: StagedCatalogState
): Map<string, number> {
  const wanted = new Map(transfer.blobs.map((blob) => [kingudMigrationBlobIdentity(blob), blob]))
  const offsets = new Map<string, number>()
  for (const upload of state.blobUploads ?? []) {
    const blob = wanted.get(kingudMigrationBlobIdentity(upload))
    // A staged key with other bytes is a different capture; restaging it would mix the two.
    if (!blob || !sameKingudMigrationBlob(blob, upload)) {
      throw new Error(`kingud_migration_blob_descriptor_conflict:${upload.blobKind}`)
    }
    offsets.set(kingudMigrationBlobIdentity(upload), upload.receivedBytes)
  }
  return offsets
}

function assertAllReceived(transfer: KingudMigrationBlobTransfer, state: StagedCatalogState): void {
  const received = receivedOffsets(transfer, state)
  for (const blob of transfer.blobs) {
    if (received.get(kingudMigrationBlobIdentity(blob)) !== blob.byteLength) {
      throw new Error(`kingud_migration_blob_transfer_incomplete:${blob.blobKind}`)
    }
  }
}

async function stageChunkWithRecovery(
  transfer: KingudMigrationBlobTransfer,
  request: KingudMigrationBlobChunkRequest,
  expectedOffset: number
): Promise<number> {
  try {
    const result = await transfer.destination.stageChunk(request)
    if (result.receivedBytes !== expectedOffset) {
      throw new Error('kingud_migration_blob_ack_invalid')
    }
    return result.receivedBytes
  } catch (error) {
    try {
      const observed = await transfer.destination.readState(transfer.manifest)
      const received =
        observed.state === 'staged'
          ? observed.blobUploads?.find(
              (entry) =>
                kingudMigrationBlobIdentity(entry) === kingudMigrationBlobIdentity(request.blob)
            )?.receivedBytes
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
