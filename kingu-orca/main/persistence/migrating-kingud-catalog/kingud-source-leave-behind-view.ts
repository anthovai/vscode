/**
 * The source as a confirmed "Move anyway" would export it, without recording the consent: lets the
 * offer appear only when leaving saved state behind would actually clear what refuses the move.
 */
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { collectKingudMigrationUntransferredDependencyCensus } from './kingud-source-dependency-census'
import { collectKingudMigrationSourceDormantState } from './kingud-source-dormant-state'
import type { KingudMigrationDeltaView } from './kingud-source-delta-view'

export function createKingudMigrationLeaveBehindView(
  runtime: Pick<StoreRuntimeState, 'state' | 'terminalScrollbackSnapshotStorage'>,
  targetId: string
): KingudMigrationDeltaView {
  // Shallow: the collectors only read, and only the target row differs.
  const state = {
    ...runtime.state,
    sshTargets: runtime.state.sshTargets.map((target) =>
      target.id === targetId
        ? { ...target, managedServerLeaveBehind: { confirmedAt: new Date(0).toISOString() } }
        : target
    )
  }
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
