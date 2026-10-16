/**
 * The source as a delta move sees it: a copy of the profile with everything earlier migrations of
 * the host already moved subtracted from it. What is left is what an older build added, and only
 * that is exported, censused and later committed.
 */
import type {
  KingudMigrationCatalogPayload,
  KingudMigrationDormantStatePayload,
  KingudMigrationManifest,
  KingudMigrationManifestSource
} from '../../../shared/kingud-migration-manifest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { subtractKingudSourceCatalogState } from './kingud-source-catalog-subtraction'
import {
  collectKingudMigrationUntransferredDependencyCensus,
  type KingudMigrationSourceDependencyCensus
} from './kingud-source-dependency-census'
import { subtractKingudMigrationSourceDormantState } from './kingud-source-dormant-subtraction'
import { collectKingudMigrationSourceDormantState } from './kingud-source-dormant-state'
import { subtractKingudMigrationScopeWorkspaceSession } from './kingud-source-workspace-session-subtraction'

export type KingudMigrationDeltaView = {
  getRepos: () => Repo[]
  getFolderWorkspaces: () => FolderWorkspace[]
  getProjectGroups: () => ProjectGroup[]
  collectKingudMigrationSourceDormantState: (
    source: KingudMigrationManifestSource,
    catalog: KingudMigrationCatalogPayload,
    destinationEnvironmentId?: string
  ) => KingudMigrationDormantStatePayload
  inspectKingudMigrationUntransferredDependencies: (
    manifest: KingudMigrationManifest
  ) => KingudMigrationSourceDependencyCensus
}

/** `moved` re-exports what the earlier migrations own today, including later edits to it. */
export function createKingudMigrationDeltaView(
  runtime: Pick<StoreRuntimeState, 'state' | 'terminalScrollbackSnapshotStorage'>,
  moved: KingudMigrationManifest
): KingudMigrationDeltaView {
  const state = structuredClone(runtime.state)
  subtractKingudSourceCatalogState(state, moved)
  subtractKingudMigrationSourceDormantState(state, moved)
  // The server owns the moved projects' tabs now, even ones the older build left unmovable.
  subtractKingudMigrationScopeWorkspaceSession(state, moved)
  const storage = runtime.terminalScrollbackSnapshotStorage
  return {
    getRepos: () => state.repos,
    getFolderWorkspaces: () => state.folderWorkspaces,
    getProjectGroups: () => state.projectGroups,
    collectKingudMigrationSourceDormantState: (source, catalog, destinationEnvironmentId) =>
      collectKingudMigrationSourceDormantState(
        state,
        source,
        catalog,
        storage,
        destinationEnvironmentId
      ).payload,
    inspectKingudMigrationUntransferredDependencies: (manifest) =>
      collectKingudMigrationUntransferredDependencyCensus(state, manifest, storage)
  }
}
