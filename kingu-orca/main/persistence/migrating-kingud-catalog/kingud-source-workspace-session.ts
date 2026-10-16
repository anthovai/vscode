import type {
  KingudMigrationCatalogPayload,
  KingudMigrationManifestSource
} from '../../../shared/kingud-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { KingudMigrationTerminalScrollbackSnapshot } from '../../../shared/kingud-migration-scrollback'
import {
  extractSessionOwnersForTransfer,
  hasTransferredSessionState
} from '../../kingu-profiles/profile-session-owner-transfer'
import type { TerminalScrollbackSnapshotStorage } from '../../terminal-scrollback-snapshots'
import {
  createKingudMigrationSourceScope,
  kingudMigrationOwnerMatchesScope,
  kingudMigrationPartitionScope,
  unqualifyKingudMigrationOwnerKey
} from './kingud-source-scope'
import {
  collectUnsupportedSessionItems,
  projectDormantSessionFocus,
  projectSessionToDestination,
  isUnsavedDraftItem,
  transferableSleepingAgentSession,
  worktreeLabel
} from './kingud-source-workspace-session-eligibility'
import { withoutLeftBehindSessionRows } from './kingud-source-left-behind-session-rows'
import {
  collectOwnedTerminalTabIds,
  dropKingudMigrationTerminalBindings
} from './kingud-source-workspace-session-layout'
import { mergeSessionFragments } from './kingud-source-workspace-session-fragments'
import {
  desktopDrafts,
  resolveCopiesForHost,
  type SessionFragment
} from './kingud-source-session-copy-resolution'
import { hasClosedTerminalTabRecord } from '../../../shared/closed-terminal-tab-tombstones'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../shared/workspace-scope'
import { kingudMigrationSessionPartitions } from './kingud-source-session-partitions'
import {
  hasDuplicateKingudMigrationScrollbackDescriptors,
  projectKingudMigrationSessionScrollback
} from './kingud-source-scrollback-state'

export type KingudMigrationSourceWorkspaceSessionInspection = {
  payload: WorkspaceSessionState | undefined
  snapshots: KingudMigrationTerminalScrollbackSnapshot[]
  /** Each names what blocks and how to clear it. */
  blockedItems: string[]
  /** What a confirmed "Move anyway" leaves in this desktop's retained profile. */
  leftBehindItems: string[]
}

const UNREADABLE_SESSION = 'saved tabs Kingu could not read'

/** Fails closed: a session shape no collector expects blocks the move instead of failing connect. */
export function collectKingudMigrationSourceWorkspaceSession(
  state: PersistedState,
  source: KingudMigrationManifestSource,
  catalog: KingudMigrationCatalogPayload,
  storage?: TerminalScrollbackSnapshotStorage,
  leaveBehind = false
): KingudMigrationSourceWorkspaceSessionInspection {
  let collected: KingudMigrationSourceWorkspaceSessionInspection
  try {
    collected = collectWorkspaceSession(state, source, catalog, storage, leaveBehind)
  } catch (error) {
    console.warn('[migration] Unreadable workspace session blocks the move:', error)
    collected = {
      payload: undefined,
      snapshots: [],
      blockedItems: [UNREADABLE_SESSION],
      leftBehindItems: []
    }
  }
  if (!leaveBehind || collected.blockedItems.length === 0) {
    return collected
  }
  // "Move anyway": what still can't move leaves the whole saved session on this desktop, unless an
  // unsaved draft would go with it. A desktop-side draft has no retained copy once the host moves.
  const drafts = desktopDrafts(state, source, catalog)
  return drafts.length > 0 || collected.blockedItems.includes(UNREADABLE_SESSION)
    ? { ...collected, blockedItems: drafts.length > 0 ? drafts : collected.blockedItems }
    : {
        payload: undefined,
        snapshots: [],
        blockedItems: [],
        leftBehindItems: [...collected.leftBehindItems, ...collected.blockedItems]
      }
}

function collectWorkspaceSession(
  state: PersistedState,
  source: KingudMigrationManifestSource,
  catalog: KingudMigrationCatalogPayload,
  storage: TerminalScrollbackSnapshotStorage | undefined,
  leaveBehind: boolean
): KingudMigrationSourceWorkspaceSessionInspection {
  const sourceScope = createKingudMigrationSourceScope({ source, catalog, repos: state.repos })
  const fragments: SessionFragment[] = []
  const blockedItems: string[] = []
  const leftBehindItems: string[] = []
  const partitions = kingudMigrationSessionPartitions(state, sourceScope).map(
    ([partitionId, saved]) => {
      const scope = kingudMigrationPartitionScope(sourceScope, partitionId)
      // A desktop-side draft stays a refusal: only the host's own rows are kept once it moves.
      const session = withoutLeftBehindSessionRows(saved, scope, leaveBehind, {
        leaveDrafts: partitionId !== LOCAL_EXECUTION_HOST_ID
      })
      return {
        saved,
        session,
        scope,
        terminalTabIds: collectOwnedTerminalTabIds(session, scope)
      }
    }
  )
  const sourceTerminalTabIds = new Set(
    partitions.flatMap(({ terminalTabIds }) => [...terminalTabIds])
  )
  for (const { saved, session, scope, terminalTabIds } of partitions) {
    const sourceHostPartition = scope.partitionHostId === scope.hostId
    const unsupported = collectUnsupportedSessionItems(
      session,
      scope,
      sourceHostPartition,
      terminalTabIds,
      sourceTerminalTabIds
    )
    if (leaveBehind) {
      // What the export dropped or never extracts stays behind; only a desktop-side draft refuses.
      const kept = new Set(unsupported.filter(isUnsavedDraftItem))
      blockedItems.push(...kept)
      leftBehindItems.push(
        ...collectUnsupportedSessionItems(
          withoutLeftBehindSessionRows(saved, scope),
          scope,
          sourceHostPartition,
          terminalTabIds,
          sourceTerminalTabIds
        ).filter((item) => !kept.has(item))
      )
    } else {
      blockedItems.push(...unsupported)
    }
    const fragment = extractSessionOwnersForTransfer(session, {
      mapOwnerKey: (ownerKey) =>
        kingudMigrationOwnerMatchesScope(ownerKey, scope)
          ? unqualifyKingudMigrationOwnerKey(ownerKey)
          : null,
      mapWorktreeId: unqualifyKingudMigrationOwnerKey,
      projectSessionFocus: sourceHostPartition
        ? ({ source, transferred, terminalTabIds }) =>
            projectDormantSessionFocus(source, transferred, scope, terminalTabIds)
        : undefined,
      projectSleepingAgentSession: (record) =>
        transferableSleepingAgentSession(record, session, scope, terminalTabIds)
          ? {
              ...structuredClone(record),
              worktreeId: unqualifyKingudMigrationOwnerKey(record.worktreeId),
              connectionId: null
            }
          : null
    })
    if (!sourceHostPartition) {
      // Client focus is not host state, so the destination never carries it.
      fragment.activeWorktreeId = null
      delete fragment.activeWorkspaceKey
    }
    dropKingudMigrationTerminalBindings(fragment)
    if (hasTransferredSessionState(fragment)) {
      const projected = projectKingudMigrationSessionScrollback(
        projectSessionToDestination(fragment, scope),
        storage,
        leaveBehind
      )
      blockedItems.push(...projected.blockedItems)
      leftBehindItems.push(...projected.leftBehindItems)
      fragments.push({
        session: projected.session,
        snapshots: projected.snapshots,
        local: scope.partitionHostId === LOCAL_EXECUTION_HOST_ID,
        sourceHost: sourceHostPartition
      })
    }
  }
  if (blockedItems.length > 0 || fragments.length === 0) {
    return { payload: undefined, snapshots: [], blockedItems, leftBehindItems }
  }
  const closedTabIds = new Set(
    partitions.flatMap(({ session }) =>
      Object.keys(session.closedTerminalTabTombstonesByTabId ?? {}).filter((tabId) =>
        hasClosedTerminalTabRecord(session.closedTerminalTabTombstonesByTabId, tabId)
      )
    )
  )
  let merged = mergeSessionFragments(
    fragments.map((fragment) => fragment.session),
    closedTabIds
  )
  let moving = fragments
  if (!merged.session && leaveBehind) {
    // "Move anyway": the host's copy moves, as the app reads it, with the desktop copy's drafts.
    const conflicting = new Set(merged.conflicts.map(normalizeWorkspaceSessionKeyToWorkspaceId))
    const resolved = resolveCopiesForHost(fragments, conflicting)
    if (resolved.clashingDrafts.length > 0) {
      return {
        payload: undefined,
        snapshots: [],
        blockedItems: resolved.clashingDrafts,
        leftBehindItems
      }
    }
    leftBehindItems.push(
      ...merged.conflicts.map(
        (ownerKey) => `this desktop's other copy of the tabs in ${worktreeLabel(ownerKey)}`
      )
    )
    moving = resolved.fragments
    merged = mergeSessionFragments(
      moving.map((fragment) => fragment.session),
      closedTabIds
    )
  }
  const snapshots = moving.flatMap((fragment) => fragment.snapshots)
  if (merged.session && hasDuplicateKingudMigrationScrollbackDescriptors(snapshots)) {
    return {
      payload: undefined,
      snapshots: [],
      blockedItems: ['terminal history saved twice for one pane'],
      leftBehindItems
    }
  }
  return merged.session
    ? { payload: merged.session, snapshots, blockedItems: [], leftBehindItems }
    : {
        payload: undefined,
        snapshots: [],
        blockedItems: merged.conflicts.map(
          (ownerKey) => `two different saved copies of the tabs in ${worktreeLabel(ownerKey)}`
        ),
        leftBehindItems
      }
}
