import { getAutomationRunRepoId } from '../../../shared/automation-run-identity'
import type { KingudMigrationManifest } from '../../../shared/kingud-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { createKingudMigrationSourceScope, kingudMigrationOwnsRepoId } from './kingud-source-scope'

/** The manifest's automations, and any a downgraded build added to a moved project since. */
export function subtractKingudMigrationSourceAutomationState(
  state: PersistedState,
  manifest: KingudMigrationManifest
): void {
  const scope = createKingudMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload,
    repos: state.repos
  })
  const automationIds = new Set([
    ...(manifest.payload.dormantState?.automations ?? []).map((entry) => entry.id),
    ...state.automations
      .filter(
        (entry) =>
          kingudMigrationOwnsRepoId(scope, getAutomationRunRepoId(entry)) &&
          (entry.executionTargetType !== 'ssh' || entry.executionTargetId === scope.targetId)
      )
      .map((entry) => entry.id)
  ])
  const runIds = new Set((manifest.payload.dormantState?.automationRuns ?? []).map((run) => run.id))
  state.automations = state.automations.filter((entry) => !automationIds.has(entry.id))
  state.automationRuns = state.automationRuns.filter(
    (run) => !runIds.has(run.id) && !automationIds.has(run.automationId)
  )
}
