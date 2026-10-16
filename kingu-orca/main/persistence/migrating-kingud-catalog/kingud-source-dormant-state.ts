import type {
  KingudMigrationCatalogPayload,
  KingudMigrationDormantStatePayload,
  KingudMigrationManifestSource
} from '../../../shared/kingud-migration-manifest'
import type { KingudMigrationDependencyKind } from '../../../shared/kingud-migration-preflight'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalScrollbackSnapshotStorage } from '../../terminal-scrollback-snapshots'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { isEmptyRetiredNameRegistry } from '../../../shared/worktree/retired-name-registry'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { toKingudDestinationRepository } from './kingud-destination-catalog-projection'
import { collectKingudMigrationRetiredWorktreeNamespaces } from './kingud-source-retired-worktree-names'
import { collectKingudMigrationSourceAutomationState } from './kingud-source-automation-state'
import { collectKingudMigrationSourceWorkspaceSession } from './kingud-source-workspace-session'
import {
  createKingudMigrationSourceScope,
  kingudMigrationOwnerMatchesScope,
  unqualifyKingudMigrationOwnerKey
} from './kingud-source-scope'
import { collectKingudMigrationSourceClientState } from './kingud-source-client-state'
import { inspectKingudSourceWorktreeMetadata } from './kingud-source-worktree-metadata'
import { compareKeys } from './kingud-source-key-order'

export const KINGUD_MIGRATION_TRANSFERRED_DORMANT_KINDS = [
  'worktree-metadata',
  'worktree-lineage',
  'workspace-lineage',
  'workspace-session',
  'automation',
  'automation-run',
  'sparse-preset',
  'retired-worktree-name',
  'mobile-tab-selection',
  'ui-routing',
  'saved-port-forward'
] as const satisfies readonly KingudMigrationDependencyKind[]

type TransferredDormantKind = (typeof KINGUD_MIGRATION_TRANSFERRED_DORMANT_KINDS)[number]

export type KingudMigrationSourceDormantInspection = {
  payload: KingudMigrationDormantStatePayload
  blockedCounts: Record<TransferredDormantKind, number>
  /** What blocks the saved tabs and panes, each with the way to clear it. */
  blockedSessionItems: string[]
  /** What a confirmed "Move anyway" leaves in this desktop's retained profile. */
  leftBehindItems: string[]
}

/** The user confirmed "Move anyway" for this host: what can't move stays on this desktop. */
export function kingudMigrationLeavesBehind(state: PersistedState, targetId: string): boolean {
  return state.sshTargets.some(
    (target) => target.id === targetId && target.managedServerLeaveBehind !== undefined
  )
}

export function collectKingudMigrationSourceDormantState(
  state: PersistedState,
  source: KingudMigrationManifestSource,
  catalog: KingudMigrationCatalogPayload,
  storage?: TerminalScrollbackSnapshotStorage,
  destinationEnvironmentId?: string
): KingudMigrationSourceDormantInspection {
  const scope = createKingudMigrationSourceScope({ source, catalog, repos: state.repos })
  const blockedCounts = emptyBlockedCounts()
  const destinationRepos = catalog.repositories.map(toKingudDestinationRepository)
  const setupByRepoId = new Map(
    projectHostSetupProjectionFromRepos(destinationRepos).setups.flatMap((setup) =>
      setup.repoId ? [[setup.repoId, setup] as const] : []
    )
  )
  const metadata = inspectKingudSourceWorktreeMetadata(state, scope)
  blockedCounts['worktree-metadata'] = metadata.blockedCount
  const worktreeMeta = uniqueDestinationRows(
    metadata.rows.flatMap(({ sourceKey, meta }) => {
      const worktreeId = unqualifyKingudMigrationOwnerKey(sourceKey)
      const setup = setupByRepoId.get(getRepoIdFromWorktreeId(worktreeId))
      return [
        {
          sourceKey,
          worktreeId,
          meta: {
            ...structuredClone(meta),
            ...(setup ? { projectId: setup.projectId, projectHostSetupId: setup.id } : {}),
            hostId: 'local' as const
          }
        }
      ]
    }),
    (entry) => entry.worktreeId,
    () => (blockedCounts['worktree-metadata'] += 1)
  )
  const worktreeLineage = uniqueDestinationRows(
    Object.entries(state.worktreeLineageById).flatMap(([sourceKey, lineage]) => {
      const touches = [sourceKey, lineage.worktreeId, lineage.parentWorktreeId].some((value) =>
        kingudMigrationOwnerMatchesScope(value, scope)
      )
      if (!touches) {
        return []
      }
      const worktreeId = unqualifyKingudMigrationOwnerKey(sourceKey)
      if (worktreeId !== lineage.worktreeId) {
        blockedCounts['worktree-lineage'] += 1
        return []
      }
      // Cross-host history belongs to the desktop and stays in its retained source profile.
      if (
        !kingudMigrationOwnerMatchesScope(lineage.worktreeId, scope) ||
        !kingudMigrationOwnerMatchesScope(lineage.parentWorktreeId, scope)
      ) {
        return []
      }
      return [{ sourceKey, worktreeId, lineage: structuredClone(lineage) }]
    }),
    (entry) => entry.worktreeId,
    () => (blockedCounts['worktree-lineage'] += 1)
  )
  const workspaceLineage = uniqueDestinationRows(
    Object.entries(state.workspaceLineageByChildKey).flatMap(([sourceKey, lineage]) => {
      const touches = [sourceKey, lineage.childWorkspaceKey, lineage.parentWorkspaceKey].some(
        (value) => kingudMigrationOwnerMatchesScope(value, scope)
      )
      if (!touches) {
        return []
      }
      const childWorkspaceKey = unqualifyKingudMigrationOwnerKey(sourceKey)
      if (childWorkspaceKey !== lineage.childWorkspaceKey) {
        blockedCounts['workspace-lineage'] += 1
        return []
      }
      if (
        !kingudMigrationOwnerMatchesScope(lineage.childWorkspaceKey, scope) ||
        !kingudMigrationOwnerMatchesScope(lineage.parentWorkspaceKey, scope)
      ) {
        return []
      }
      return [
        {
          sourceKey,
          childWorkspaceKey,
          lineage: {
            ...structuredClone(lineage),
            childInstanceId: lineage.childInstanceId ?? null,
            parentInstanceId: lineage.parentInstanceId ?? null
          }
        }
      ]
    }),
    (entry) => entry.childWorkspaceKey,
    () => (blockedCounts['workspace-lineage'] += 1)
  )
  // A repo id another host shares keys one registry for both hosts: it stays where it is.
  const ownedRepoIds = [...scope.repoIds].filter((repoId) => !scope.sharedRepoIds.has(repoId))
  const sparsePresets = ownedRepoIds
    .flatMap((repoId) => state.sparsePresetsByRepo[repoId] ?? [])
    .map((preset) => structuredClone(preset))
    .sort((left, right) =>
      compareKeys(`${left.repoId}\0${left.id}`, `${right.repoId}\0${right.id}`)
    )
  const retiredWorktreeNames = ownedRepoIds
    .flatMap((repoId) => {
      const registry = state.retiredWorktreeNamesByRepo?.[repoId]
      return registry && !isEmptyRetiredNameRegistry(registry)
        ? [{ repoId, registry: structuredClone(registry) }]
        : []
    })
    .sort((left, right) => compareKeys(left.repoId, right.repoId))
  const leaveBehind = kingudMigrationLeavesBehind(state, scope.targetId)
  const workspaceSession = collectKingudMigrationSourceWorkspaceSession(
    state,
    source,
    catalog,
    storage,
    leaveBehind
  )
  const blockedSessionItems = [...workspaceSession.blockedItems]
  const automationState = collectKingudMigrationSourceAutomationState(state, source, catalog)
  blockedCounts.automation = automationState.blockedAutomationCount
  blockedCounts['automation-run'] = automationState.blockedRunCount
  const clientState = collectKingudMigrationSourceClientState(
    state,
    source,
    catalog,
    destinationEnvironmentId,
    workspaceSession.payload
  )
  blockedCounts['saved-port-forward'] = clientState.blockedCounts['saved-port-forward']
  const leftBehindItems = [...workspaceSession.leftBehindItems]
  const duplicateCloses = Array.from(
    { length: clientState.blockedCount },
    () => 'a browser page close saved twice'
  )
  // "Move anyway": duplicate closes are already out of the payload. What the session still refuses
  // is what can't be left behind (an unsaved draft), so it keeps blocking.
  ;(leaveBehind ? leftBehindItems : blockedSessionItems).push(...duplicateCloses)
  blockedCounts['workspace-session'] = blockedSessionItems.length
  if (leaveBehind) {
    // Every row these counts name is already out of the payload. Saved port forwards never block,
    // and the server itself refuses duplicate ports.
    for (const kind of KINGUD_MIGRATION_TRANSFERRED_DORMANT_KINDS) {
      if (
        kind !== 'workspace-session' &&
        kind !== 'saved-port-forward' &&
        blockedCounts[kind] > 0
      ) {
        leftBehindItems.push(`${blockedCounts[kind]} saved ${kind} record(s)`)
        blockedCounts[kind] = 0
      }
    }
  }
  return {
    payload: {
      version: 1,
      worktreeMeta: worktreeMeta.sort((left, right) =>
        compareKeys(left.worktreeId, right.worktreeId)
      ),
      worktreeLineage: worktreeLineage.sort((left, right) =>
        compareKeys(left.worktreeId, right.worktreeId)
      ),
      workspaceLineage: workspaceLineage.sort((left, right) =>
        compareKeys(left.childWorkspaceKey, right.childWorkspaceKey)
      ),
      sparsePresets,
      retiredWorktreeNames,
      retiredWorktreeNamespaces: collectKingudMigrationRetiredWorktreeNamespaces(state, catalog),
      ...(workspaceSession.payload ? { workspaceSession: workspaceSession.payload } : {}),
      ...(workspaceSession.snapshots.length > 0
        ? { terminalScrollbackSnapshots: workspaceSession.snapshots }
        : {}),
      ...(automationState.automations.length > 0
        ? { automations: automationState.automations }
        : {}),
      ...(automationState.automationRuns.length > 0
        ? { automationRuns: automationState.automationRuns }
        : {}),
      ...(clientState.payload ? { clientState: clientState.payload } : {})
    },
    blockedCounts,
    blockedSessionItems,
    leftBehindItems
  }
}

export function emptyDormantPayload(): KingudMigrationDormantStatePayload {
  return {
    version: 1,
    worktreeMeta: [],
    worktreeLineage: [],
    workspaceLineage: [],
    sparsePresets: [],
    retiredWorktreeNames: [],
    retiredWorktreeNamespaces: []
  }
}

function uniqueDestinationRows<T>(
  rows: T[],
  key: (row: T) => string,
  onDuplicate: () => void
): T[] {
  const unique = new Map<string, T>()
  const duplicates = new Set<string>()
  for (const row of rows) {
    const rowKey = key(row)
    if (duplicates.has(rowKey)) {
      onDuplicate()
    } else if (unique.has(rowKey)) {
      unique.delete(rowKey)
      duplicates.add(rowKey)
      onDuplicate()
    } else {
      unique.set(rowKey, row)
    }
  }
  return [...unique.values()]
}

function emptyBlockedCounts(): Record<TransferredDormantKind, number> {
  return {
    'worktree-metadata': 0,
    'worktree-lineage': 0,
    'workspace-lineage': 0,
    'workspace-session': 0,
    automation: 0,
    'automation-run': 0,
    'sparse-preset': 0,
    'retired-worktree-name': 0,
    'mobile-tab-selection': 0,
    'ui-routing': 0,
    'saved-port-forward': 0
  }
}
