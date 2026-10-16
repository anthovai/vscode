/**
 * The server's record of which migrations it committed and which are still staged. A commit must
 * read as committed for as long as a client could ask, and an abandoned stage must not hold the
 * server awake or take a staging slot forever.
 */
import {
  MAX_KINGUD_MIGRATION_IMPORT_RECEIPTS,
  type KingudMigrationImportReceipt,
  type KingudMigrationManifest
} from '../../../shared/kingud-migration-manifest'
import { MAX_KINGUD_MIGRATION_EVICTED_RECEIPTS } from '../../../shared/kingud-migration-evicted-receipts'
import type { PersistedState } from '../../../shared/persisted-state-types'

// A client resumes a stage within minutes; a week only covers a host left offline meanwhile.
export const KINGUD_MIGRATION_STAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function findKingudMigrationImportReceipt(
  state: PersistedState,
  manifest: KingudMigrationManifest
): KingudMigrationImportReceipt | undefined {
  const receipt = state.kingudMigrationImportReceipts?.find(
    (entry) => entry.migrationId === manifest.migrationId
  )
  if (receipt) {
    return receipt
  }
  const evicted = state.kingudMigrationEvictedReceipts?.find(
    (entry) => entry.migrationId === manifest.migrationId
  )
  // Everything else a receipt holds is the manifest's own: rebuilt, it still checks against it.
  return evicted
    ? {
        version: manifest.version,
        migrationId: evicted.migrationId,
        manifestSha256: evicted.manifestSha256,
        source: structuredClone(manifest.source),
        importedAt: evicted.importedAt,
        repositoryIds: manifest.payload.repositories.map((repo) => repo.id),
        projectGroupIds: manifest.payload.projectGroups.map((group) => group.id),
        folderWorkspaceIds: manifest.payload.folderWorkspaces.map((workspace) => workspace.id)
      }
    : undefined
}

/** Appends a receipt; one that ages out of the bounded list keeps its commit as a compact record. */
export function recordKingudMigrationImportReceipt(
  state: PersistedState,
  receipt: KingudMigrationImportReceipt
): void {
  const receipts = [...(state.kingudMigrationImportReceipts ?? []), receipt]
  const overflow = receipts.length - MAX_KINGUD_MIGRATION_IMPORT_RECEIPTS
  if (overflow > 0) {
    state.kingudMigrationEvictedReceipts = [
      ...(state.kingudMigrationEvictedReceipts ?? []),
      ...receipts.slice(0, overflow).map(({ migrationId, manifestSha256, importedAt }) => ({
        migrationId,
        manifestSha256,
        importedAt
      }))
    ].slice(-MAX_KINGUD_MIGRATION_EVICTED_RECEIPTS)
  }
  state.kingudMigrationImportReceipts = receipts.slice(-MAX_KINGUD_MIGRATION_IMPORT_RECEIPTS)
}

export function isLiveKingudMigrationStage(stagedAt: string, now: number): boolean {
  return now - Date.parse(stagedAt) < KINGUD_MIGRATION_STAGE_TTL_MS
}

/** Drops stages no client came back for; returns whether any went. */
export function expireKingudMigrationStages(state: PersistedState, now: number): boolean {
  const staged = state.kingudMigrationStagedCatalogs ?? []
  const live = staged.filter((entry) => isLiveKingudMigrationStage(entry.stagedAt, now))
  if (live.length === staged.length) {
    return false
  }
  state.kingudMigrationStagedCatalogs = live
  return true
}
