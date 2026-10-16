import type { KingudMigrationManifest } from '../../../shared/kingud-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { subtractKingudSourceWorktreeMetadata } from './kingud-source-worktree-metadata'
import { subtractKingudMigrationSourceAutomationState } from './kingud-source-automation-subtraction'
import { subtractKingudMigrationSourceWorkspaceSession } from './kingud-source-workspace-session-subtraction'
import { subtractKingudMigrationClientState } from './kingud-source-client-subtraction'

/** On a copy of the profile only: what an earlier migration moved, gone from the delta view. */
export function subtractKingudMigrationSourceDormantState(
  state: PersistedState,
  manifest: KingudMigrationManifest
): void {
  // By scope, even with no dormant state: a downgraded build may have added some since.
  subtractKingudSourceWorktreeMetadata(state, manifest)
  subtractKingudMigrationSourceAutomationState(state, manifest)
  const dormant = manifest.payload.dormantState
  if (!dormant) {
    return
  }
  dormant.worktreeLineage.forEach((entry) => delete state.worktreeLineageById[entry.sourceKey])
  dormant.workspaceLineage.forEach(
    (entry) => delete state.workspaceLineageByChildKey[entry.sourceKey]
  )
  for (const preset of dormant.sparsePresets) {
    const remaining = (state.sparsePresetsByRepo[preset.repoId] ?? []).filter(
      (entry) => entry.id !== preset.id
    )
    if (remaining.length > 0) {
      state.sparsePresetsByRepo[preset.repoId] = remaining
    } else {
      delete state.sparsePresetsByRepo[preset.repoId]
    }
  }
  for (const entry of dormant.retiredWorktreeNames) {
    delete state.retiredWorktreeNamesByRepo?.[entry.repoId]
  }
  subtractKingudMigrationSourceWorkspaceSession(state, manifest)
  subtractKingudMigrationClientState(state, manifest)
  // Retain snapshot files: the prior durable profile and rollback evidence can still reference them.
}
