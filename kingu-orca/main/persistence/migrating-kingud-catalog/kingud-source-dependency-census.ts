import type { KingudMigrationManifest } from '../../../shared/kingud-migration-manifest'
import {
  KINGUD_MIGRATION_DEPENDENCY_KINDS,
  type KingudMigrationDependencyKind
} from '../../../shared/kingud-migration-preflight'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalScrollbackSnapshotStorage } from '../../terminal-scrollback-snapshots'
import {
  inspectKingudMigrationSourceSessions,
  type KingudMigrationSourceSessionInspection
} from './kingud-source-session-dependencies'
import {
  collectKingudMigrationSourceDormantState,
  kingudMigrationLeavesBehind
} from './kingud-source-dormant-state'
import {
  createKingudMigrationSourceScope,
  kingudMigrationOwnerMatchesScope,
  kingudMigrationPartitionScope,
  type KingudMigrationSourceScope
} from './kingud-source-scope'
import { paneBelongsToTabs } from '../../../shared/workspace-session-pane-ownership'

export type KingudMigrationSourceDependencyCensus = {
  totalCount: number
  counts: Record<KingudMigrationDependencyKind, number>
  /** For the kinds it can name: what blocks and how to clear it. */
  names?: Partial<Record<KingudMigrationDependencyKind, string[]>>
}

/** What still references the target that this manifest cannot carry. */
export function collectKingudMigrationUntransferredDependencyCensus(
  state: PersistedState,
  manifest: KingudMigrationManifest,
  storage?: TerminalScrollbackSnapshotStorage
): KingudMigrationSourceDependencyCensus {
  const scope = createKingudMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload,
    repos: state.repos
  })
  const sessions = inspectKingudMigrationSourceSessions(state, {
    hostId: scope.hostId,
    ownerMatches: (ownerKey, partitionHostId) =>
      kingudMigrationOwnerMatchesScope(
        ownerKey,
        kingudMigrationPartitionScope(scope, partitionHostId)
      )
  })
  const dormant = collectKingudMigrationSourceDormantState(
    state,
    manifest.source,
    manifest.payload,
    storage,
    manifest.destinationEnvironmentId
  )
  const counts: Record<KingudMigrationDependencyKind, number> = {
    ...dormant.blockedCounts,
    'terminal-lease': state.sshRemotePtyLeases.filter(
      (lease) => lease.targetId === scope.targetId && lease.state !== 'terminated'
    ).length,
    // Left behind, recovery records stay with this desktop; the terminal gate still proves exit.
    'terminal-recovery': kingudMigrationLeavesBehind(state, scope.targetId)
      ? 0
      : countTerminalRecoveryState(state, scope, sessions)
  }
  return {
    counts,
    totalCount: KINGUD_MIGRATION_DEPENDENCY_KINDS.reduce((total, kind) => total + counts[kind], 0),
    names:
      dormant.blockedSessionItems.length > 0
        ? { 'workspace-session': dormant.blockedSessionItems }
        : {}
  }
}

// Consumer recoveries never block: the terminal gate proves before every move that their leases exited.
function countTerminalRecoveryState(
  state: PersistedState,
  scope: KingudMigrationSourceScope,
  sessions: KingudMigrationSourceSessionInspection
): number {
  const unsupported = state.migrationUnsupportedPtyEntries.filter(
    (entry) =>
      kingudMigrationOwnerMatchesScope(entry.worktreeId, scope) ||
      (entry.tabId ? sessions.tabIds.has(entry.tabId) : false) ||
      sessions.ptyIds.has(entry.ptyId) ||
      (entry.paneKey ? paneBelongsToTabs(entry.paneKey, sessions.tabIds) : false)
  ).length
  const aliases = state.legacyPaneKeyAliasEntries.filter(
    (entry) =>
      paneBelongsToTabs(entry.legacyPaneKey, sessions.tabIds) ||
      paneBelongsToTabs(entry.stablePaneKey, sessions.tabIds)
  ).length
  return unsupported + aliases
}
