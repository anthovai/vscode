import { hostStableKey } from '../../../shared/automation-owner-key'
import { parsePersistedAutomationHostFilter } from '../../../shared/automation-host-filter'
import type {
  KingudMigrationClientStatePayload,
  KingudMigrationUiRoutingState
} from '../../../shared/kingud-migration-client-state'
import type {
  KingudMigrationCatalogPayload,
  KingudMigrationManifestSource
} from '../../../shared/kingud-migration-manifest'
import type {
  PersistedMobileClientTabSelection,
  PersistedState
} from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { sessionPartitions } from './kingud-source-workspace-session-fragments'
import { collectCloseIntents } from './kingud-source-client-browser-intents'
import {
  createKingudMigrationSourceScope,
  kingudMigrationOwnerMatchesScope,
  kingudMigrationOwnsRepoId,
  unqualifyKingudMigrationOwnerKey
} from './kingud-source-scope'
import { paneBelongsToTabs } from '../../../shared/workspace-session-pane-ownership'

export type KingudMigrationSourceClientStateInspection = {
  payload: KingudMigrationClientStatePayload | undefined
  /** Duplicate closes are folded into the existing workspace-session blocker. */
  blockedCount: number
  /** Mobile selections and sidebar routing are presentation: what can't move stays behind. */
  blockedCounts: { 'saved-port-forward': number }
}

export function collectKingudMigrationSourceClientState(
  state: PersistedState,
  source: KingudMigrationManifestSource,
  catalog: KingudMigrationCatalogPayload,
  destinationEnvironmentId: string | undefined,
  eligibleSession: WorkspaceSessionState | undefined
): KingudMigrationSourceClientStateInspection {
  const scope = createKingudMigrationSourceScope({ source, catalog, repos: state.repos })
  const blockedCounts = { 'saved-port-forward': 0 }
  let blockedCount = 0
  const mobile = collectMobileSelections(state, scope, eligibleSession)
  const uiRouting = collectUiRouting(state, scope, destinationEnvironmentId, eligibleSession)
  const target = state.sshTargets.find((entry) => entry.id === scope.targetId)
  const savedPortForwards = target?.portForwards ? structuredClone(target.portForwards) : undefined
  if (savedPortForwards) {
    const ports = new Set<number>()
    for (const forward of savedPortForwards) {
      if (ports.has(forward.localPort)) {
        blockedCounts['saved-port-forward'] += 1
      }
      ports.add(forward.localPort)
    }
  }
  const closeIntents = collectCloseIntents(
    state,
    scope,
    destinationEnvironmentId,
    eligibleSession,
    () => {
      blockedCount += 1
    }
  )
  const clientState: KingudMigrationClientStatePayload = {
    ...(mobile && Object.keys(mobile).length > 0
      ? { mobileClientTabSelectionsByDeviceId: mobile }
      : {}),
    ...(uiRouting && Object.keys(uiRouting).length > 0 ? { uiRouting } : {}),
    ...(savedPortForwards && savedPortForwards.length > 0 ? { savedPortForwards } : {}),
    ...(closeIntents && closeIntents.length > 0
      ? { clientHostedBrowserCloseIntents: closeIntents }
      : {})
  }
  return {
    payload: Object.keys(clientState).length > 0 ? clientState : undefined,
    blockedCount,
    blockedCounts
  }
}

function collectMobileSelections(
  state: PersistedState,
  scope: ReturnType<typeof createKingudMigrationSourceScope>,
  session: WorkspaceSessionState | undefined
):
  | NonNullable<KingudMigrationClientStatePayload['mobileClientTabSelectionsByDeviceId']>
  | undefined {
  const eligible = session ? collectEligibleSessionIdentity(session, scope) : null
  const result: NonNullable<
    KingudMigrationClientStatePayload['mobileClientTabSelectionsByDeviceId']
  > = {}
  const destinationKeys = new Set<string>()
  for (const [deviceId, selections] of Object.entries(
    state.mobileClientTabSelectionsByDeviceId ?? {}
  )) {
    const projected: Record<string, PersistedMobileClientTabSelection> = {}
    for (const [ownerKey, selection] of Object.entries(selections)) {
      if (!kingudMigrationOwnerMatchesScope(ownerKey, scope)) {
        continue
      }
      const destinationKey = unqualifyKingudMigrationOwnerKey(ownerKey)
      const representable = representableMobileSelection(selection, eligible)
      // A selection naming a tab that did not move, or a second copy for one worktree, stays behind.
      if (!representable || destinationKeys.has(`${deviceId}\0${destinationKey}`)) {
        continue
      }
      destinationKeys.add(`${deviceId}\0${destinationKey}`)
      projected[destinationKey] = representable
    }
    if (Object.keys(projected).length > 0) {
      result[deviceId] = projected
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function collectUiRouting(
  state: PersistedState,
  scope: ReturnType<typeof createKingudMigrationSourceScope>,
  destinationEnvironmentId: string | undefined,
  session: WorkspaceSessionState | undefined
): KingudMigrationUiRoutingState | undefined {
  const ui = state.ui
  const result: KingudMigrationUiRoutingState = {}
  if (ui.lastActiveRepoId && kingudMigrationOwnsRepoId(scope, ui.lastActiveRepoId)) {
    result.lastActiveRepoId = ui.lastActiveRepoId
  }
  if (ui.lastActiveWorktreeId && kingudMigrationOwnerMatchesScope(ui.lastActiveWorktreeId, scope)) {
    result.lastActiveWorktreeId = unqualifyKingudMigrationOwnerKey(ui.lastActiveWorktreeId)
  }
  const filterRepoIds = ui.filterRepoIds.filter((repoId) =>
    kingudMigrationOwnsRepoId(scope, repoId)
  )
  if (filterRepoIds.length > 0) {
    result.filterRepoIds = filterRepoIds
  }
  const dotfiles = Object.entries(ui.showDotfilesByWorktree ?? {})
    .filter(([ownerKey]) => kingudMigrationOwnerMatchesScope(ownerKey, scope))
    .map(([ownerKey, enabled]) => [unqualifyKingudMigrationOwnerKey(ownerKey), enabled] as const)
  if (dotfiles.length > 0) {
    result.showDotfilesByWorktree = Object.fromEntries(dotfiles)
  }
  const dismissed = (ui.setupScriptPromptDismissedRepoIds ?? []).filter((repoId) =>
    kingudMigrationOwnsRepoId(scope, repoId)
  )
  if (dismissed.length > 0) {
    result.setupScriptPromptDismissedRepoIds = dismissed
  }
  const manualOrder = (ui.manualRepoOrder ?? [])
    .filter((entry) => entry.hostId === scope.hostId && scope.repoIds.has(entry.repoId))
    .map((entry) => ({ hostId: 'local' as const, repoId: entry.repoId }))
  if (manualOrder.length > 0) {
    result.manualRepoOrder = manualOrder
  }
  if (ui.workspaceHostScope === scope.hostId) {
    result.workspaceHostScope = 'local'
  }
  const visibleHosts = (ui.visibleWorkspaceHostIds ?? []).filter(
    (hostId) => hostId === scope.hostId
  )
  if (visibleHosts.length > 0) {
    result.visibleWorkspaceHostIds = ['local']
  }
  const hostOrder = (ui.workspaceHostOrder ?? []).filter((hostId) => hostId === scope.hostId)
  if (hostOrder.length > 0) {
    result.workspaceHostOrder = ['local']
  }
  const filter = parsePersistedAutomationHostFilter(ui.automationHostFilter)
  if (
    filter.kind === 'host' &&
    hostStableKey(filter.host) === `host:desktop:ssh:${encodeURIComponent(scope.targetId)}`
  ) {
    result.automationHostFilter = destinationEnvironmentId
      ? {
          kind: 'host',
          hostKey: hostStableKey({
            authority: { kind: 'runtime', environmentId: destinationEnvironmentId },
            selector: { kind: 'self' }
          })
        }
      : { kind: 'host', hostKey: 'host:desktop:self' }
  }
  const eligible = session ? collectEligibleSessionIdentity(session, scope) : null
  const sourceTabIds = collectSourceOwnedTabIds(state, scope)
  const acknowledgements = Object.entries(ui.acknowledgedAgentsByPaneKey ?? {}).filter(
    ([paneKey]) => {
      // An acknowledgement for a pane that did not move stays behind with that pane.
      return (
        paneBelongsToTabs(paneKey, sourceTabIds) &&
        eligible !== null &&
        paneBelongsToTabs(paneKey, eligible.tabIds)
      )
    }
  )
  if (acknowledgements.length > 0) {
    result.acknowledgedAgentsByPaneKey = Object.fromEntries(acknowledgements)
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/** Every tab the source owns: its own partition's, and those keyed to its projects anywhere. */
function collectSourceOwnedTabIds(
  state: PersistedState,
  scope: ReturnType<typeof createKingudMigrationSourceScope>
): Set<string> {
  const tabIds = new Set<string>()
  for (const [hostId, session] of sessionPartitions(state, 'local')) {
    for (const [ownerKey, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
      if (hostId === scope.hostId || kingudMigrationOwnerMatchesScope(ownerKey, scope)) {
        tabs.forEach((tab) => tabIds.add(tab.id))
      }
    }
  }
  return tabIds
}

type EligibleSessionIdentity = { tabIds: ReadonlySet<string>; groupIds: ReadonlySet<string> }

function collectEligibleSessionIdentity(
  session: WorkspaceSessionState,
  scope: ReturnType<typeof createKingudMigrationSourceScope>
): EligibleSessionIdentity {
  const tabIds = new Set<string>()
  const groupIds = new Set<string>()
  for (const [ownerKey, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
    if (!kingudMigrationOwnerMatchesScope(ownerKey, scope)) {
      continue
    }
    tabs.forEach((tab) => tabIds.add(tab.id))
  }
  for (const [ownerKey, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    if (kingudMigrationOwnerMatchesScope(ownerKey, scope)) {
      tabs.forEach((tab) => tabIds.add(tab.id))
    }
  }
  for (const [ownerKey, groups] of Object.entries(session.tabGroups ?? {})) {
    if (!kingudMigrationOwnerMatchesScope(ownerKey, scope)) {
      continue
    }
    groups.forEach((group) => groupIds.add(group.id))
  }
  return { tabIds, groupIds }
}

/** A phone names a terminal by its pane, `${tabId}::${leafId}`; the pane moves with its tab. */
function movedMobileTab(id: string, tabIds: ReadonlySet<string>): boolean {
  const separator = id.indexOf('::')
  return tabIds.has(id) || (separator !== -1 && tabIds.has(id.slice(0, separator)))
}

/** The selection without references to tabs or groups that did not move; null when none is left. */
function representableMobileSelection(
  selection: PersistedMobileClientTabSelection,
  eligible: EligibleSessionIdentity | null
): PersistedMobileClientTabSelection | null {
  const tabIds = eligible?.tabIds ?? new Set<string>()
  const groupIds = eligible?.groupIds ?? new Set<string>()
  const next: PersistedMobileClientTabSelection = {
    activeTabId:
      selection.activeTabId !== null && movedMobileTab(selection.activeTabId, tabIds)
        ? selection.activeTabId
        : null,
    activeGroupId:
      selection.activeGroupId !== null && groupIds.has(selection.activeGroupId)
        ? selection.activeGroupId
        : null,
    activeTabIdByGroupId: Object.fromEntries(
      Object.entries(selection.activeTabIdByGroupId).filter(
        ([groupId, tabId]) => groupIds.has(groupId) && tabIds.has(tabId)
      )
    )
  }
  return next.activeTabId === null &&
    next.activeGroupId === null &&
    Object.keys(next.activeTabIdByGroupId).length === 0
    ? null
    : next
}
