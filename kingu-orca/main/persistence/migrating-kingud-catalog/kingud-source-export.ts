/**
 * The Store's read-only view of a relay-hosted SSH target, for migrating it to a managed kingud.
 *
 * Everything here reads the profile-state store and returns copies; nothing writes or deletes
 * source rows, and nothing else deletes them after an import either.
 */
import {
  KINGUD_MIGRATION_SCROLLBACK_CHUNK_BYTES,
  type KingudMigrationTerminalScrollbackSnapshot
} from '../../../shared/kingud-migration-scrollback'
import type {
  KingudMigrationCatalogPayload,
  KingudMigrationDormantStatePayload,
  KingudMigrationManifest,
  KingudMigrationManifestSource
} from '../../../shared/kingud-migration-manifest'
import { assertKingudMigrationManifestDigest } from '../../kingud/kingud-migration-manifest-digest'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import {
  collectKingudMigrationUntransferredDependencyCensus,
  type KingudMigrationSourceDependencyCensus
} from './kingud-source-dependency-census'
import { collectKingudMigrationSourceDormantState } from './kingud-source-dormant-state'
import { readKingudMigrationSourceScrollbackChunk } from './kingud-source-scrollback-state'
import {
  createKingudMigrationDeltaView,
  type KingudMigrationDeltaView
} from './kingud-source-delta-view'
import { syncKingudMigrationScrollbackRetention } from './kingud-source-scrollback-retention'
import { createKingudMigrationLeaveBehindView } from './kingud-source-leave-behind-view'

type KingudSourceExportRuntime = Pick<
  StoreRuntimeState,
  'state' | 'terminalScrollbackSnapshotStorage' | 'retainedScrollbackRefsByMigrationId'
>

const kingudSourceExportContext = Symbol('KingudSourceExportPersistence')

export class KingudSourceExportPersistence {
  readonly [kingudSourceExportContext]: KingudSourceExportRuntime

  constructor(runtime: KingudSourceExportRuntime) {
    this[kingudSourceExportContext] = runtime
  }

  collectKingudMigrationSourceDormantState(
    source: KingudMigrationManifestSource,
    catalog: KingudMigrationCatalogPayload,
    destinationEnvironmentId?: string
  ): KingudMigrationDormantStatePayload {
    const runtime = this[kingudSourceExportContext]
    return collectKingudMigrationSourceDormantState(
      runtime.state,
      source,
      catalog,
      runtime.terminalScrollbackSnapshotStorage,
      destinationEnvironmentId
    ).payload
  }

  /** A copy of the source with `moved` subtracted from it, for a delta move. */
  createKingudMigrationDeltaView(moved: KingudMigrationManifest): KingudMigrationDeltaView {
    return createKingudMigrationDeltaView(this[kingudSourceExportContext], moved)
  }

  /** The source as a confirmed "Move anyway" would export it, consent unrecorded. */
  createKingudMigrationLeaveBehindView(targetId: string): KingudMigrationDeltaView {
    return createKingudMigrationLeaveBehindView(this[kingudSourceExportContext], targetId)
  }

  /** What still references the target that this manifest cannot carry. */
  inspectKingudMigrationUntransferredDependencies(
    manifest: KingudMigrationManifest
  ): KingudMigrationSourceDependencyCensus {
    const runtime = this[kingudSourceExportContext]
    return collectKingudMigrationUntransferredDependencyCensus(
      runtime.state,
      manifest,
      runtime.terminalScrollbackSnapshotStorage
    )
  }

  /** Holds the snapshots unfinished migrations name; see syncKingudMigrationScrollbackRetention. */
  syncKingudMigrationScrollbackRetention(pending: readonly KingudMigrationManifest[]): void {
    syncKingudMigrationScrollbackRetention(this[kingudSourceExportContext], pending)
  }

  /**
   * One bounded chunk of a scrollback snapshot the signed manifest names. The bytes are checked
   * against the manifest's length and digest, so a buffer that changed since export is refused.
   */
  readKingudMigrationSourceSnapshotChunk(
    manifest: KingudMigrationManifest,
    ref: string,
    offset: number
  ): { bytesBase64: string; totalBytes: number; eof: boolean } {
    assertKingudMigrationManifestDigest(manifest)
    const descriptor: KingudMigrationTerminalScrollbackSnapshot | undefined =
      manifest.payload.dormantState?.terminalScrollbackSnapshots?.find((entry) => entry.ref === ref)
    if (!descriptor) {
      throw new Error('kingud_migration_source_snapshot_unknown')
    }
    const runtime = this[kingudSourceExportContext]
    return readKingudMigrationSourceScrollbackChunk({
      state: runtime.state,
      descriptor,
      retained: [...runtime.retainedScrollbackRefsByMigrationId.values()].some((refs) =>
        refs.has(ref)
      ),
      offset,
      length: KINGUD_MIGRATION_SCROLLBACK_CHUNK_BYTES,
      storage: runtime.terminalScrollbackSnapshotStorage
    })
  }
}
