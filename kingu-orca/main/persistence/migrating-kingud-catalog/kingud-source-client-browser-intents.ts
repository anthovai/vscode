import type { KingudMigrationClientHostedBrowserCloseIntent } from '../../../shared/kingud-migration-client-state'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  kingudMigrationOwnerMatchesScope,
  unqualifyKingudMigrationOwnerKey,
  type KingudMigrationSourceScope
} from './kingud-source-scope'

export function collectCloseIntents(
  state: PersistedState,
  scope: KingudMigrationSourceScope,
  destinationEnvironmentId: string | undefined,
  eligibleSession: WorkspaceSessionState | undefined,
  onBlocked: () => void
): KingudMigrationClientHostedBrowserCloseIntent[] | undefined {
  const eligiblePages = new Set<string>()
  for (const [ownerKey, pages] of Object.entries(
    eligibleSession?.clientHostedBrowserPagesByWorktree ?? {}
  )) {
    if (!kingudMigrationOwnerMatchesScope(ownerKey, scope)) {
      continue
    }
    const worktreeId = unqualifyKingudMigrationOwnerKey(ownerKey)
    for (const page of pages) {
      eligiblePages.add(`${worktreeId}\0${page.browserPageId}`)
    }
  }
  const result: KingudMigrationClientHostedBrowserCloseIntent[] = []
  const seen = new Set<string>()
  const sessions = [
    state.workspaceSession,
    ...Object.values(state.workspaceSessionsByHostId ?? {}).flatMap((entry) =>
      entry ? [entry] : []
    )
  ].filter((entry): entry is WorkspaceSessionState => Boolean(entry))
  for (const session of sessions) {
    for (const [sourceEnvironmentId, intents] of Object.entries(
      session.clientHostedBrowserCloseIntentsByEnvironment ?? {}
    )) {
      // Intents already keyed to the destination were handled by a prior retry.
      if (sourceEnvironmentId === destinationEnvironmentId) {
        continue
      }
      for (const intent of intents) {
        if (!kingudMigrationOwnerMatchesScope(intent.worktreeId, scope)) {
          continue
        }
        const worktreeId = unqualifyKingudMigrationOwnerKey(intent.worktreeId)
        const key = `${sourceEnvironmentId}\0${intent.browserPageId}\0${worktreeId}`
        // A close for a page the move does not carry stays with this client, which still owes it.
        if (
          !eligiblePages.has(`${worktreeId}\0${intent.browserPageId}`) ||
          !destinationEnvironmentId
        ) {
          continue
        }
        if (seen.has(key)) {
          onBlocked()
          continue
        }
        seen.add(key)
        result.push({
          sourceEnvironmentId,
          browserPageId: intent.browserPageId,
          worktreeId,
          closedAt: intent.closedAt
        })
      }
    }
  }
  return result.length > 0 ? result : undefined
}
