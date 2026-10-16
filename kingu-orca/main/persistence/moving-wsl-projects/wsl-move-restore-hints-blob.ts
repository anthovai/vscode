/**
 * The quiesce step's restore hints as the `terminal-restore-hints` migration blob: the bytes, the
 * descriptor the destination checks them against, and the source the blob sender reads from.
 */
import { createHash } from 'node:crypto'
import type { KingudMigrationBlobDescriptor } from '../../../shared/kingud-migration-blob-transfer'
import { sameKingudMigrationBlob } from '../../../shared/kingud-migration-blob-transfer'
import {
  MAX_KINGUD_MIGRATION_TERMINAL_RESTORE_HINTS_BYTES,
  KINGUD_MIGRATION_TERMINAL_RESTORE_HINTS_KEY,
  KINGUD_MIGRATION_TERMINAL_RESTORE_HINTS_VERSION,
  parseKingudMigrationTerminalRestoreHintsDocument,
  type KingudMigrationTerminalRestoreHint
} from '../../../shared/kingud-migration-terminal-restore-hints'
import type { KingudMigrationBlobSource } from '../../ssh/kingud-migration-blob-coordinator'

export type WslMoveRestoreHintsBlob = {
  descriptor: KingudMigrationBlobDescriptor
  bytes: Buffer
  source: KingudMigrationBlobSource
}

/** Null when there is nothing to carry: the channel sends empty content as no blob at all. */
export function buildWslMoveRestoreHintsBlob(
  hints: readonly KingudMigrationTerminalRestoreHint[]
): WslMoveRestoreHintsBlob | null {
  if (hints.length === 0) {
    return null
  }
  // Validated here so a bad hint fails the move on this side, before anything is staged.
  const document = parseKingudMigrationTerminalRestoreHintsDocument({
    version: KINGUD_MIGRATION_TERMINAL_RESTORE_HINTS_VERSION,
    hints: hints.map((hint) => ({ paneKey: hint.paneKey, cwd: hint.cwd }))
  })
  const bytes = Buffer.from(JSON.stringify(document), 'utf8')
  if (bytes.length > MAX_KINGUD_MIGRATION_TERMINAL_RESTORE_HINTS_BYTES) {
    throw new Error('kingud_migration_terminal_restore_hints_too_large')
  }
  const descriptor: KingudMigrationBlobDescriptor = {
    blobKind: 'terminal-restore-hints',
    key: KINGUD_MIGRATION_TERMINAL_RESTORE_HINTS_KEY,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length
  }
  return {
    descriptor,
    bytes,
    source: {
      readChunk: async (requested, offset, maxBytes) => {
        if (!sameKingudMigrationBlob(requested, descriptor)) {
          throw new Error(`kingud_migration_source_blob_changed:${requested.blobKind}`)
        }
        return bytes.subarray(offset, offset + maxBytes)
      }
    }
  }
}
