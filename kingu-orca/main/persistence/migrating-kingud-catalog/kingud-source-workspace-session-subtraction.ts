import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { markdownFileIdCandidates } from '../../kingu-profiles/profile-session-markdown-transfer'
import { removeWorkspaceSessionOwners } from '../restoring-sessions/session-owner-removal'
import {
  createKingudMigrationSourceScope,
  kingudMigrationOwnerMatchesScope,
  kingudMigrationOwnsRepoId,
  kingudMigrationPartitionScope,
  type KingudMigrationSourceScope
} from './kingud-source-scope'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../shared/execution-host'
import { collectSessionOwnerKeys } from './kingud-source-workspace-session-fragments'
import type { KingudMigrationManifest } from '../../../shared/kingud-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'

/** On a copy of the profile only, like every subtraction the delta view runs. */
export function subtractKingudMigrationSourceWorkspaceSession(
  state: PersistedState,
  manifest: KingudMigrationManifest
): void {
  if (!manifest.payload.dormantState?.workspaceSession) {
    return
  }
  subtractKingudMigrationScopeWorkspaceSession(state, manifest)
}

/** Every partition's session state for the manifest's catalog, whether or not it could move. */
export function subtractKingudMigrationScopeWorkspaceSession(
  state: PersistedState,
  manifest: KingudMigrationManifest
): void {
  const scope = createKingudMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload,
    repos: state.repos
  })
  state.workspaceSession = removeOwnedSessionState(
    state.workspaceSession,
    kingudMigrationPartitionScope(scope, LOCAL_EXECUTION_HOST_ID)
  )
  const partitions = state.workspaceSessionsByHostId
  if (partitions) {
    state.workspaceSessionsByHostId = Object.fromEntries(
      Object.entries(partitions).map(([hostId, session]) => [
        hostId,
        session
          ? removeOwnedSessionState(session, kingudMigrationPartitionScope(scope, hostId))
          : session
      ])
    )
  }
}

function removeOwnedSessionState(
  session: WorkspaceSessionState,
  scope: KingudMigrationSourceScope
): WorkspaceSessionState {
  const ownerKeys = new Set(
    [...collectSessionOwnerKeys(session)].filter((ownerKey) =>
      kingudMigrationOwnerMatchesScope(ownerKey, scope)
    )
  )
  const removedMarkdownFileIds = new Set<string>()
  for (const [ownerKey, files] of Object.entries(session.openFilesByWorktree ?? {})) {
    if (!kingudMigrationOwnerMatchesScope(ownerKey, scope)) {
      continue
    }
    for (const file of files) {
      markdownFileIdCandidates(file.filePath, ownerKey, file.runtimeEnvironmentId).forEach((id) =>
        removedMarkdownFileIds.add(id)
      )
    }
  }
  // Focus retargeted to the destination names the same ids on the managed host; keep it.
  const retargetedFocus = isKingudRuntimeHostFocus(session)
    ? {
        activeRepoId: session.activeRepoId,
        activeWorktreeId: session.activeWorktreeId,
        activeWorkspaceKey: session.activeWorkspaceKey,
        activeTabId: session.activeTabId
      }
    : null
  const next = removeWorkspaceSessionOwners(session, ownerKeys) ?? session
  // Selection-only sessions and canonical workspace keys need the same scoped subtraction.
  const retired = next === session ? structuredClone(session) : next
  if (retargetedFocus) {
    Object.assign(retired, retargetedFocus)
  } else {
    if (kingudMigrationOwnsRepoId(scope, retired.activeRepoId)) {
      retired.activeRepoId = null
    }
    if (kingudMigrationOwnerMatchesScope(retired.activeWorktreeId, scope)) {
      retired.activeWorktreeId = null
    }
    if (kingudMigrationOwnerMatchesScope(retired.activeWorkspaceKey, scope)) {
      retired.activeWorkspaceKey = null
    }
  }
  if (retired.activeWorkspaceExecutionHostId === scope.hostId) {
    retired.activeWorkspaceExecutionHostId = null
  }
  if (retired.markdownFrontmatterVisible) {
    retired.markdownFrontmatterVisible = Object.fromEntries(
      Object.entries(retired.markdownFrontmatterVisible).filter(
        ([fileId]) => !removedMarkdownFileIds.has(fileId)
      )
    )
  }
  for (const repoId of scope.repoIds) {
    if (!scope.sharedRepoIds.has(repoId)) {
      delete retired.terminalTopologyRevisionByRepoId?.[repoId]
    }
  }
  return retired
}

/** Focus already on a runtime host names that host's workspace, never the SSH source's. */
function isKingudRuntimeHostFocus(session: WorkspaceSessionState): boolean {
  return parseExecutionHostId(session.activeWorkspaceExecutionHostId)?.kind === 'runtime'
}
