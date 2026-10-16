import {
  normalizeKingudMigrationImportReceipts,
  type KingudMigrationCatalogAbortResult,
  type KingudMigrationCatalogState,
  type KingudMigrationManifest
} from './kingud-migration-manifest'
import { parseKingudMigrationSnapshotUploadStates } from './kingud-migration-scrollback'
import { parseKingudMigrationBlobUploadStates } from './kingud-migration-blob-transfer'
import { isRecord } from './kingud-migration-manifest-fields'

export function parseKingudMigrationCatalogState(
  value: unknown,
  manifest: KingudMigrationManifest
): KingudMigrationCatalogState {
  const record = requireRecord(value)
  if (
    record.migrationId !== manifest.migrationId ||
    record.manifestSha256 !== manifest.manifestSha256
  ) {
    throw new Error('kingud_migration_catalog_state_identity_mismatch')
  }
  if (record.state === 'absent') {
    return { state: 'absent', ...migrationIdentity(manifest) }
  }
  if (record.state === 'staged') {
    const stagedAt = requireDate(record.stagedAt)
    const snapshotUploads = parseKingudMigrationSnapshotUploadStates(
      record.snapshotUploads,
      manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
    )
    const blobUploads = parseKingudMigrationBlobUploadStates(record.blobUploads)
    return {
      state: 'staged',
      ...migrationIdentity(manifest),
      stagedAt,
      ...(snapshotUploads ? { snapshotUploads } : {}),
      ...(blobUploads ? { blobUploads } : {})
    }
  }
  if (record.state === 'committed') {
    const receipt = normalizeKingudMigrationImportReceipts([record.receipt])[0]
    if (
      !receipt ||
      receipt.migrationId !== manifest.migrationId ||
      receipt.manifestSha256 !== manifest.manifestSha256
    ) {
      throw new Error('kingud_migration_catalog_state_receipt_invalid')
    }
    return { state: 'committed', ...migrationIdentity(manifest), receipt }
  }
  // No known arm is safe to assume for a newer host's state; stop with an actionable reason.
  if (typeof record.state === 'string') {
    throw new Error('kingud_migration_catalog_state_unsupported:client_update_required')
  }
  throw new Error('kingud_migration_catalog_state_invalid')
}

export function parseKingudMigrationCatalogAbortResult(
  value: unknown,
  manifest: KingudMigrationManifest
): KingudMigrationCatalogAbortResult {
  const state = parseKingudMigrationCatalogState(value, manifest)
  const record = requireRecord(value)
  if (typeof record.aborted !== 'boolean') {
    throw new Error('kingud_migration_catalog_abort_result_invalid')
  }
  if (
    record.durableAbsent !== undefined &&
    (record.durableAbsent !== true || state.state !== 'absent')
  ) {
    throw new Error('kingud_migration_catalog_abort_durability_invalid')
  }
  return {
    ...state,
    aborted: record.aborted,
    ...(record.durableAbsent === true ? { durableAbsent: true as const } : {})
  }
}

function migrationIdentity(manifest: KingudMigrationManifest) {
  return { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('kingud_migration_catalog_state_invalid')
  }
  return value
}

function requireDate(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('kingud_migration_catalog_state_staged_at_invalid')
  }
  return value
}
