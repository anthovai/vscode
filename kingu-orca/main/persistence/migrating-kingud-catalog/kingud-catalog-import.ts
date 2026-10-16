import {
  MAX_KINGUD_MIGRATION_STAGED_CATALOGS,
  KINGUD_MIGRATION_MANIFEST_VERSION,
  type KingudMigrationCatalogAbortResult,
  type KingudMigrationCatalogState,
  type KingudMigrationImportReceipt,
  type KingudMigrationManifest
} from '../../../shared/kingud-migration-manifest'
import type {
  KingudMigrationSnapshotChunkRequest,
  KingudMigrationSnapshotChunkResult
} from '../../../shared/kingud-migration-scrollback'
import type {
  KingudMigrationBlobChunkRequest,
  KingudMigrationBlobChunkResult,
  KingudMigrationBlobDescriptor
} from '../../../shared/kingud-migration-blob-transfer'
import type { RepoLifecycleOperations } from '../loading-store/repo-lifecycle-operations'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import type { WriteSchedulingOperations } from '../loading-store/write-scheduling'
import { scheduleSave } from '../loading-store/write-scheduling'
import {
  applyPreparedKingudMigrationCatalog,
  assertKingudMigrationReceiptMatchesManifest,
  assertSameKingudMigrationManifest,
  prepareKingudMigrationCatalog,
  type PreparedKingudMigrationCatalog
} from './kingud-catalog-records'
import {
  expireKingudMigrationStages,
  findKingudMigrationImportReceipt,
  isLiveKingudMigrationStage,
  recordKingudMigrationImportReceipt
} from './kingud-catalog-receipt-ledger'
import {
  abortKingudMigrationSnapshots,
  assertKingudMigrationSnapshotsReady,
  commitKingudMigrationSnapshots,
  inspectKingudMigrationSnapshotUploads,
  pruneKingudMigrationSnapshotStaging,
  stageKingudMigrationSnapshotChunk
} from './kingud-scrollback-snapshot-transfer'
import {
  abortKingudMigrationBlobs,
  assertKingudMigrationBlobSetMatches,
  assertKingudMigrationBlobsReady,
  commitKingudMigrationBlobs,
  inspectKingudMigrationBlobUploads,
  pruneKingudMigrationBlobStaging,
  stageKingudMigrationBlobChunk
} from './kingud-migration-blob-staging'
import { assertKingudMigrationBlobContentsValid } from './kingud-migration-blob-installers'

type KingudCatalogImportRuntime = Pick<
  StoreRuntimeState,
  'state' | 'terminalScrollbackSnapshotStorage' | 'kingudMigrationBlobRoot'
>

const kingudCatalogImportContext = Symbol('KingudCatalogImportPersistence')
type KingudCatalogImportContext = {
  runtime: KingudCatalogImportRuntime
  repos: RepoLifecycleOperations
  scheduling: WriteSchedulingOperations
}

// Manifests arrive parsed; the RPC boundary verified the digest over the bytes as sent.
export class KingudCatalogImportPersistence {
  readonly [kingudCatalogImportContext]: KingudCatalogImportContext

  constructor(
    runtime: KingudCatalogImportRuntime,
    repos: RepoLifecycleOperations,
    scheduling: WriteSchedulingOperations
  ) {
    this[kingudCatalogImportContext] = { runtime, repos, scheduling }
  }

  stageKingudMigrationCatalog(
    manifest: KingudMigrationManifest,
    options: { now?: () => Date } = {}
  ): KingudMigrationCatalogState {
    const context = this[kingudCatalogImportContext]
    const now = options.now ?? (() => new Date())
    if (expireKingudMigrationStages(context.runtime.state, now().getTime())) {
      scheduleSave(context.scheduling)
    }
    pruneKingudMigrationSnapshotStaging(
      stagedManifests(context.runtime.state),
      context.runtime.terminalScrollbackSnapshotStorage
    )
    pruneKingudMigrationBlobStaging(
      stagedManifests(context.runtime.state),
      committedMigrations(context.runtime.state),
      context.runtime.kingudMigrationBlobRoot
    )
    const current = migrationCatalogState(context.runtime, manifest)
    if (current.state === 'committed') {
      return current
    }
    prepareKingudMigrationCatalog(manifest, context.runtime.state)
    if (current.state === 'staged') {
      return current
    }
    const staged = context.runtime.state.kingudMigrationStagedCatalogs ?? []
    if (staged.length >= MAX_KINGUD_MIGRATION_STAGED_CATALOGS) {
      throw new Error('kingud_migration_staging_capacity_exceeded')
    }
    const stagedAt = now().toISOString()
    context.runtime.state.kingudMigrationStagedCatalogs = [
      ...staged,
      {
        version: KINGUD_MIGRATION_MANIFEST_VERSION,
        manifest: structuredClone(manifest),
        stagedAt
      }
    ]
    scheduleSave(context.scheduling)
    return stagedCatalogState(manifest, stagedAt, context.runtime)
  }

  stageKingudMigrationSnapshotChunk(
    request: KingudMigrationSnapshotChunkRequest
  ): KingudMigrationSnapshotChunkResult {
    const context = this[kingudCatalogImportContext]
    return stageKingudMigrationSnapshotChunk({
      stagedManifest:
        stagedManifests(context.runtime.state).find(
          (manifest) => manifest.migrationId === request.migrationId
        ) ?? null,
      storage: context.runtime.terminalScrollbackSnapshotStorage,
      request
    })
  }

  stageKingudMigrationBlobChunk(
    request: KingudMigrationBlobChunkRequest
  ): KingudMigrationBlobChunkResult {
    const context = this[kingudCatalogImportContext]
    return stageKingudMigrationBlobChunk({
      stagedManifest:
        stagedManifests(context.runtime.state).find(
          (manifest) => manifest.migrationId === request.migrationId
        ) ?? null,
      root: context.runtime.kingudMigrationBlobRoot,
      request
    })
  }

  /** `expectedBlobs` absent (SSH, older senders) keeps the pre-blob-set commit unchanged. */
  commitStagedKingudMigrationCatalog(
    manifest: KingudMigrationManifest,
    options: { now?: () => Date; expectedBlobs?: readonly KingudMigrationBlobDescriptor[] } = {}
  ): KingudMigrationCatalogState {
    const context = this[kingudCatalogImportContext]
    const current = migrationCatalogState(context.runtime, manifest)
    if (current.state === 'committed') {
      return current
    }
    if (current.state !== 'staged') {
      throw new Error('kingud_migration_catalog_not_staged')
    }
    const prepared = prepareKingudMigrationCatalog(manifest, context.runtime.state)
    assertKingudMigrationSnapshotsReady(manifest, context.runtime.terminalScrollbackSnapshotStorage)
    if (options.expectedBlobs) {
      assertKingudMigrationBlobSetMatches(
        manifest,
        context.runtime.kingudMigrationBlobRoot,
        options.expectedBlobs
      )
    }
    assertKingudMigrationBlobsReady(manifest, context.runtime.kingudMigrationBlobRoot)
    assertKingudMigrationBlobContentsValid(manifest, context.runtime.kingudMigrationBlobRoot)
    commitKingudMigrationSnapshots(manifest, context.runtime.terminalScrollbackSnapshotStorage)
    commitKingudMigrationBlobs(manifest, context.runtime.kingudMigrationBlobRoot)
    const receipt = commitPreparedCatalog(context, manifest, prepared, options.now)
    scheduleSave(context.scheduling)
    return committedCatalogState(receipt)
  }

  abortStagedKingudMigrationCatalog(
    manifest: KingudMigrationManifest
  ): KingudMigrationCatalogAbortResult {
    const context = this[kingudCatalogImportContext]
    const current = migrationCatalogState(context.runtime, manifest)
    if (current.state === 'committed' || current.state === 'absent') {
      return { ...current, aborted: false }
    }
    // Dormant import only: nothing but this stage references the staged rows before commit.
    context.runtime.state.kingudMigrationStagedCatalogs = (
      context.runtime.state.kingudMigrationStagedCatalogs ?? []
    ).filter((entry) => entry.manifest.migrationId !== manifest.migrationId)
    abortKingudMigrationSnapshots(manifest, context.runtime.terminalScrollbackSnapshotStorage)
    abortKingudMigrationBlobs(manifest, context.runtime.kingudMigrationBlobRoot)
    scheduleSave(context.scheduling)
    return { ...absentCatalogState(manifest), aborted: true }
  }

  getKingudMigrationCatalogState(manifest: KingudMigrationManifest): KingudMigrationCatalogState {
    const context = this[kingudCatalogImportContext]
    return migrationCatalogState(context.runtime, manifest)
  }

  /** A migration into this server staged recently and neither committed nor aborted. */
  hasStagedKingudMigrationCatalog(now: number = Date.now()): boolean {
    return (
      this[kingudCatalogImportContext].runtime.state.kingudMigrationStagedCatalogs ?? []
    ).some((entry) => isLiveKingudMigrationStage(entry.stagedAt, now))
  }
}

function commitPreparedCatalog(
  context: KingudCatalogImportContext,
  manifest: KingudMigrationManifest,
  prepared: PreparedKingudMigrationCatalog,
  now?: () => Date
): KingudMigrationImportReceipt {
  applyPreparedKingudMigrationCatalog(prepared, context.runtime.state, context.repos)
  const receipt: KingudMigrationImportReceipt = {
    version: KINGUD_MIGRATION_MANIFEST_VERSION,
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    source: structuredClone(manifest.source),
    importedAt: (now ?? (() => new Date()))().toISOString(),
    repositoryIds: prepared.repositories.map((repo) => repo.id),
    projectGroupIds: prepared.projectGroups.map((group) => group.id),
    folderWorkspaceIds: prepared.folderWorkspaces.map((workspace) => workspace.id)
  }
  context.runtime.state.kingudMigrationStagedCatalogs = (
    context.runtime.state.kingudMigrationStagedCatalogs ?? []
  ).filter((entry) => entry.manifest.migrationId !== manifest.migrationId)
  recordKingudMigrationImportReceipt(context.runtime.state, receipt)
  return receipt
}

function migrationCatalogState(
  runtime: KingudCatalogImportRuntime,
  manifest: KingudMigrationManifest
): KingudMigrationCatalogState {
  const { state } = runtime
  const receipt = findKingudMigrationImportReceipt(state, manifest)
  if (receipt) {
    assertCommittedReceipt(receipt, manifest)
    return committedCatalogState(receipt)
  }
  const staged = state.kingudMigrationStagedCatalogs?.find(
    (entry) => entry.manifest.migrationId === manifest.migrationId
  )
  if (!staged) {
    return absentCatalogState(manifest)
  }
  assertSameKingudMigrationManifest(staged.manifest, manifest)
  return stagedCatalogState(manifest, staged.stagedAt, runtime)
}

function stagedManifests(state: StoreRuntimeState['state']): KingudMigrationManifest[] {
  return (state.kingudMigrationStagedCatalogs ?? []).map((entry) => entry.manifest)
}

function committedMigrations(
  state: StoreRuntimeState['state']
): { migrationId: string; manifestSha256: string }[] {
  return [
    ...(state.kingudMigrationImportReceipts ?? []),
    ...(state.kingudMigrationEvictedReceipts ?? [])
  ]
}

/**
 * The receipt alone proves the commit: the server is live afterwards, so its rows and snapshot
 * files may legitimately change, and a later read must still say "committed".
 */
function assertCommittedReceipt(
  receipt: KingudMigrationImportReceipt,
  manifest: KingudMigrationManifest
): void {
  if (receipt.manifestSha256 !== manifest.manifestSha256) {
    throw new Error('kingud_migration_id_reused_with_different_manifest')
  }
  assertKingudMigrationReceiptMatchesManifest(receipt, manifest)
}

function absentCatalogState(manifest: KingudMigrationManifest): KingudMigrationCatalogState {
  return {
    state: 'absent',
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256
  }
}

function stagedCatalogState(
  manifest: KingudMigrationManifest,
  stagedAt: string,
  runtime: KingudCatalogImportRuntime
): KingudMigrationCatalogState {
  const snapshotUploads = inspectKingudMigrationSnapshotUploads(
    manifest,
    runtime.terminalScrollbackSnapshotStorage
  )
  // Absent, not empty, when nothing is staged: the shape an older host already answers with.
  const blobUploads = inspectKingudMigrationBlobUploads(manifest, runtime.kingudMigrationBlobRoot)
  return {
    state: 'staged',
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    stagedAt,
    ...(snapshotUploads ? { snapshotUploads } : {}),
    ...(blobUploads ? { blobUploads } : {})
  }
}

function committedCatalogState(receipt: KingudMigrationImportReceipt): KingudMigrationCatalogState {
  return {
    state: 'committed',
    migrationId: receipt.migrationId,
    manifestSha256: receipt.manifestSha256,
    receipt: structuredClone(receipt)
  }
}
