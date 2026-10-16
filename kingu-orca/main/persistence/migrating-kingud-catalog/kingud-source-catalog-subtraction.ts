/**
 * Subtracts a migrated target's catalog rows from a copy of the source profile (the delta view).
 * Only rows the manifest names and the target still owns go; a group stays while anything outside
 * the migration references it. The live profile is never passed here.
 */
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import type { KingudMigrationManifest } from '../../../shared/kingud-migration-manifest'
import { requireKingudMigrationSshSource } from '../../../shared/kingud-migration-source-kind'
import {
  kingudSourceFolderWorkspaceIds,
  repoBelongsToKingudSource
} from './kingud-source-ownership'

export function subtractKingudSourceCatalogState(
  state: StoreRuntimeState['state'],
  manifest: KingudMigrationManifest
): void {
  const repoIds = new Set(manifest.payload.repositories.map((repo) => repo.id))
  const folderIds = new Set(manifest.payload.folderWorkspaces.map((workspace) => workspace.id))
  const groupIds = new Set(manifest.payload.projectGroups.map((group) => group.id))
  const targetId = requireKingudMigrationSshSource(manifest.source).sshTargetId
  // Before any repo goes: a folder owned through the repos inside it would read as local after.
  const ownedFolderIds = kingudSourceFolderWorkspaceIds(state, targetId)
  state.repos = state.repos.filter(
    (repo) => !(repoIds.has(repo.id) && repoBelongsToKingudSource(repo, targetId))
  )
  state.folderWorkspaces = state.folderWorkspaces.filter(
    (workspace) => !(folderIds.has(workspace.id) && ownedFolderIds.has(workspace.id))
  )
  removeUnreferencedSourceGroups(state, groupIds, targetId)
}

function removeUnreferencedSourceGroups(
  state: StoreRuntimeState['state'],
  candidateIds: ReadonlySet<string>,
  targetId: string
): void {
  let removed = true
  while (removed) {
    removed = false
    const referencedIds = new Set([
      ...state.repos.flatMap((repo) => (repo.projectGroupId ? [repo.projectGroupId] : [])),
      ...state.folderWorkspaces.map((workspace) => workspace.projectGroupId),
      ...state.projectGroups.flatMap((group) => (group.parentGroupId ? [group.parentGroupId] : []))
    ])
    const next = state.projectGroups.filter((group) => {
      const shouldRemove =
        candidateIds.has(group.id) &&
        group.connectionId === targetId &&
        !referencedIds.has(group.id)
      removed ||= shouldRemove
      return !shouldRemove
    })
    state.projectGroups = next
  }
}
