/**
 * A converted host's source rows: hidden from this build's lists, which show the managed server
 * instead, and kept for a downgraded build that still reads them. Nothing here ever deletes them;
 * only stopping the server, removing the host or uninstalling does.
 *
 * On every start the rows are compared with what the migration committed. If an older build
 * changed them, the host is marked `sourceChangedAt`: its rows show again, it stays on the relay,
 * and it needs a new move. A second manifest is never merged into the server automatically.
 */
import { createHash } from 'node:crypto'
import { getAppEnvironment } from '../../shared/app-environment'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { KingudMigrationCatalogPayload } from '../../shared/kingud-migration-manifest'
import {
  isRetainedKingudMigrationSourceCutover,
  type KingudMigrationSourceCutover
} from '../../shared/kingud-migration-source-cutover'
import type { Repo } from '../../shared/repo-types'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { getKingudSshDeployment } from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { collectKingudMigrationSourceCatalog } from '../persistence/migrating-kingud-catalog/kingud-source-catalog'
import {
  kingudSourceFolderWorkspaceIds,
  projectGroupBelongsToKingudSource,
  repoBelongsToKingudSource
} from '../persistence/migrating-kingud-catalog/kingud-source-ownership'
import { findKingudMigrationSourceCutoverForTarget } from './kingud-migration-cutover-journal'
import {
  withoutWslMovedFolderWorkspaces,
  withoutWslMovedRepos
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'

const appUserDataPath = (): string => getAppEnvironment().getPath('userData')

type CatalogStore = Pick<Store, 'getFolderWorkspaces' | 'getProjectGroups' | 'getRepos'>
type TargetStore = Pick<Store, 'getSshTargets' | 'updateSshTarget'>

/**
 * Whether this build hides the host's source rows: committed to its server and not changed by an
 * older build since. Mid-migration the rows stay shown, since the source is still authoritative,
 * and so does a fence no journal explains (an empty host's deploy): no move owns those rows.
 */
export function isHiddenRetainedSourceTarget(
  userDataPath: string,
  target: Pick<SshTarget, 'id' | 'kingudFence'>
): boolean {
  if (!target.kingudFence || target.kingudFence.sourceChangedAt) {
    return false
  }
  let head: KingudMigrationSourceCutover | null
  try {
    head = findKingudMigrationSourceCutoverForTarget(userDataPath, target.id)
  } catch {
    return true // An unreadable journal keeps the host fenced, and so hidden.
  }
  return (
    head !== null &&
    (head.phase === 'destination-committed' ||
      head.phase === 'source-retired' ||
      head.destinationEnvironmentId !== target.kingudFence.environmentId)
  )
}

/** `getUserDataPath` is read only once a host is fenced, so unfenced lists never touch the journal. */
export function hiddenRetainedSourceTargetIds(
  getUserDataPath: () => string,
  targets: readonly SshTarget[]
): string[] {
  return targets
    .filter(
      (target) => target.kingudFence && isHiddenRetainedSourceTarget(getUserDataPath(), target)
    )
    .map((target) => target.id)
}

/**
 * A fenced host's `ssh:` session partition is migration source from the fence on: a renderer save
 * would change it mid-conversion, and strip the rows this build hides once it commits.
 */
export function isFrozenKingudSourceSessionPartition(
  store: Pick<Store, 'getSshTarget'>,
  hostId: string | null | undefined
): boolean {
  const parsed = parseExecutionHostId(hostId)
  const fence =
    parsed?.kind === 'ssh' ? store.getSshTarget(parsed.targetId)?.kingudFence : undefined
  return fence !== undefined && !fence.sourceChangedAt
}

export function visibleRepos(
  store: CatalogStore & Pick<Store, 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): Repo[] {
  const hidden = hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  const repos = withoutWslMovedRepos(store.getRepos())
  if (hidden.length === 0) {
    return repos
  }
  return repos.filter(
    (repo) => !hidden.some((targetId) => repoBelongsToKingudSource(repo, targetId))
  )
}

/** Hides only groups the host owns; a local group holding one of its projects stays. */
export function visibleProjectGroups(
  store: Pick<Store, 'getProjectGroups' | 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): ProjectGroup[] {
  const hidden = hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  const groups = store.getProjectGroups()
  if (hidden.length === 0) {
    return groups
  }
  return groups.filter(
    (group) => !hidden.some((targetId) => projectGroupBelongsToKingudSource(group, targetId))
  )
}

export function visibleFolderWorkspaces(
  store: CatalogStore & Pick<Store, 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): FolderWorkspace[] {
  const hidden = hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  const folderWorkspaces = withoutWslMovedFolderWorkspaces(store.getFolderWorkspaces())
  if (hidden.length === 0) {
    return folderWorkspaces
  }
  const state = {
    repos: store.getRepos(),
    projectGroups: store.getProjectGroups(),
    folderWorkspaces
  }
  const hiddenIds = new Set(
    hidden.flatMap((targetId) => [...kingudSourceFolderWorkspaceIds(state, targetId)])
  )
  return folderWorkspaces.filter((workspace) => !hiddenIds.has(workspace.id))
}

/**
 * Identity only, hashed to fit the journal: an older build adding, removing or moving a project is
 * a change, a touched timestamp is not.
 */
export function kingudCatalogFingerprint(catalog: KingudMigrationCatalogPayload): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        catalog.repositories.map((repo) => `${repo.id}\0${repo.path}`).sort(),
        catalog.folderWorkspaces.map((folder) => `${folder.id}\0${folder.folderPath}`).sort(),
        catalog.projectGroups.map((group) => group.id).sort()
      ])
    )
    .digest('hex')
}

export function currentKingudSourceFingerprint(
  store: CatalogStore,
  target: Pick<SshTarget, 'id'>
): string {
  return kingudCatalogFingerprint(collectKingudMigrationSourceCatalog(store, target))
}

/** What the retained source must still look like for this build to keep serving it from kingud. */
export function retainedKingudSourceBaseline(head: KingudMigrationSourceCutover): string {
  return head.sourceBaselineFingerprint ?? kingudCatalogFingerprint(head.manifest.payload)
}

type RetainedSourceVerdict = 'unchanged' | 'changed'

/** Identity only: an older build's edits inside moved projects stay in the retained rows. */
function compareRetainedKingudSource(
  store: CatalogStore,
  target: Pick<SshTarget, 'id'>,
  head: KingudMigrationSourceCutover
): RetainedSourceVerdict {
  return currentKingudSourceFingerprint(store, target) === retainedKingudSourceBaseline(head)
    ? 'unchanged'
    : 'changed'
}

/**
 * Startup pass: restore a fence the profile lost from the registered managed server, and mark a
 * retained host whose rows an older build changed. Never throws; a failed pass changes nothing.
 */
export function reconcileManagedKingudSshTargets(
  userDataPath: string,
  store: CatalogStore & TargetStore,
  now: () => Date = () => new Date()
): void {
  try {
    restoreFencesFromManagedServers(userDataPath, store)
    markChangedRetainedSources(userDataPath, store, now)
  } catch (error) {
    console.warn('[ssh] Could not reconcile managed Kingu server hosts:', error)
  }
}

function restoreFencesFromManagedServers(userDataPath: string, store: TargetStore): void {
  const targets = new Map(store.getSshTargets().map((target) => [target.id, target]))
  for (const environment of listEnvironments(userDataPath)) {
    const deployment = getKingudSshDeployment(environment)
    const target = deployment ? targets.get(deployment.sshTargetId) : undefined
    // Why generation-bound: a host re-created under the same id is a different registration.
    if (target && !target.kingudFence && target.generation === deployment?.sshTargetGeneration) {
      store.updateSshTarget(target.id, { kingudFence: { environmentId: environment.id } })
    }
  }
}

function markChangedRetainedSources(
  userDataPath: string,
  store: CatalogStore & TargetStore,
  now: () => Date
): void {
  for (const target of store.getSshTargets()) {
    const fence = target.kingudFence
    const head = fence ? findKingudMigrationSourceCutoverForTarget(userDataPath, target.id) : null
    if (
      !fence ||
      !head ||
      fence.environmentId !== head.destinationEnvironmentId ||
      fence.sourceChangedAt
    ) {
      continue
    }
    // A delta move a crash interrupted lost its mark with it; the mark leads back to resuming it.
    const interruptedDelta =
      head.supersedesMigrationId !== undefined &&
      (head.phase === 'source-fenced' || head.phase === 'destination-staged')
    if (
      interruptedDelta ||
      (isRetainedKingudMigrationSourceCutover(head) &&
        compareRetainedKingudSource(store, target, head) === 'changed')
    ) {
      store.updateSshTarget(target.id, {
        kingudFence: { ...fence, sourceChangedAt: now().toISOString() }
      })
    }
  }
}
