/**
 * Planning a delta move for a host an older build changed after it was converted: what the move
 * adds, what the server keeps as it is, and the source view every later check of the move reads.
 *
 * The view subtracts what the host's earlier migrations already moved, re-exported as it is today,
 * so the delta manifest carries only rows and dormant state no earlier migration owns. Nothing
 * that overlaps an earlier migration is merged into the server.
 */
import type {
  KingudDeltaMovePreview,
  KingudDeltaMoveRow
} from '../../shared/kingud-managed-runtime'
import type {
  KingudMigrationCatalogPayload,
  KingudMigrationManifest
} from '../../shared/kingud-migration-manifest'
import { isRetainedKingudMigrationSourceCutover } from '../../shared/kingud-migration-source-cutover'
import type { KingudMigrationSourceCutover } from '../../shared/kingud-migration-source-cutover'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { collectKingudMigrationSourceCatalog } from '../persistence/migrating-kingud-catalog/kingud-source-catalog'
import { listKingudMigrationCutoverChainForTarget } from './kingud-migration-cutover-journal'
import {
  createKingudMigrationManifest,
  kingudMigrationCatalogIds,
  type KingudMigrationCatalogIds
} from './kingud-migration-manifest-export'
import type { KingudMigrationSnapshotSource } from './kingud-migration-snapshot-coordinator'
import { collectUntransferredDependentBlockers } from './ssh-target-kingud-dependents'
import type { KingudMigrationPreflightStore } from './ssh-target-kingud-preflight'

export type KingudDeltaSourceStore = KingudMigrationPreflightStore & KingudMigrationSnapshotSource

/** A delta move journaled but not yet committed and kept: the next move resumes it. */
export function unfinishedKingudDelta(
  chain: readonly KingudMigrationSourceCutover[]
): KingudMigrationSourceCutover | null {
  const head = chain.at(-1)
  return head?.supersedesMigrationId &&
    head.phase !== 'source-retired' &&
    !isRetainedKingudMigrationSourceCutover(head)
    ? head
    : null
}

/** The committed migrations a delta extends, oldest first, excluding any delta in flight. */
export function committedKingudMigrationChain(
  chain: readonly KingudMigrationSourceCutover[]
): KingudMigrationSourceCutover[] {
  return (unfinishedKingudDelta(chain) ? chain.slice(0, -1) : chain).filter(
    (cutover) => cutover.phase === 'destination-committed' || cutover.phase === 'source-retired'
  )
}

/** The real store, except its catalog and dormant state: those come from the delta view. */
export function kingudDeltaSourceStore(
  store: Store,
  target: SshTarget,
  moved: readonly KingudMigrationSourceCutover[]
): KingudDeltaSourceStore {
  const ids = kingudMigrationCatalogIds(moved.map((cutover) => cutover.manifest.payload))
  // A linked project is the server's already, so a delta never moves it either.
  const linked = moved.flatMap((cutover) => cutover.linkedRepositoryIds ?? [])
  return kingudSourceStoreWithout(
    store,
    target,
    { ...ids, repositoryIds: new Set([...ids.repositoryIds, ...linked]) },
    moved.at(-1)?.destinationEnvironmentId
  )
}

/** The source minus rows the server already owns, and the dormant state that references them. */
export function kingudSourceStoreWithout(
  store: Store,
  target: SshTarget,
  owned: KingudMigrationCatalogIds,
  destinationEnvironmentId: string | undefined
): KingudDeltaSourceStore {
  const ownedNow = createKingudMigrationManifest(store, target, {
    destinationEnvironmentId,
    onlyCatalog: owned
  })
  const view = store.createKingudMigrationDeltaView(ownedNow)
  return {
    ...view,
    getSshTarget: (id) => store.getSshTarget(id),
    getSshRemotePtyLeases: (id) => store.getSshRemotePtyLeases(id),
    readKingudMigrationSourceSnapshotChunk: (...args) =>
      store.readKingudMigrationSourceSnapshotChunk(...args)
  }
}

export type KingudDeltaMovePlan = KingudDeltaMovePreview & {
  manifest: KingudMigrationManifest
  moved: KingudMigrationSourceCutover[]
  /** The retained migration a new delta supersedes. */
  head: KingudMigrationSourceCutover
  /** An interrupted delta this move resumes from its journaled manifest instead of a new one. */
  resumes: KingudMigrationSourceCutover | null
  source: KingudDeltaSourceStore
}

/** Throws when the host is not a converted host an older build changed. */
export function planKingudDeltaMove(
  userDataPath: string,
  store: Store,
  target: SshTarget,
  options: { migrationId?: string; now?: () => Date } = {}
): KingudDeltaMovePlan {
  const environmentId = target.kingudFence?.environmentId
  if (!environmentId || !target.kingudFence?.sourceChangedAt) {
    throw new Error('kingud_delta_not_changed')
  }
  const chain = listKingudMigrationCutoverChainForTarget(userDataPath, target.id)
  const resumes = unfinishedKingudDelta(chain)
  const moved = committedKingudMigrationChain(chain)
  const head = chain.at(resumes ? -2 : -1)
  if (
    !head ||
    !isRetainedKingudMigrationSourceCutover(head) ||
    moved.at(-1)?.migrationId !== head.migrationId
  ) {
    throw new Error('kingud_delta_no_retained_migration')
  }
  const source = kingudDeltaSourceStore(store, target, moved)
  const manifest =
    resumes?.manifest ??
    createKingudMigrationManifest(source, target, {
      migrationId: options.migrationId,
      now: options.now,
      destinationEnvironmentId: environmentId
    })
  const current = collectKingudMigrationSourceCatalog(store, target)
  return {
    sshTargetId: target.id,
    environmentId,
    added: catalogRows(manifest.payload),
    notReflected: notReflected(
      current,
      moved.map((cutover) => cutover.manifest.payload)
    ),
    blockers: collectUntransferredDependentBlockers(source, manifest),
    manifest,
    moved,
    head,
    resumes,
    source
  }
}

function catalogRows(catalog: KingudMigrationCatalogPayload): KingudDeltaMoveRow[] {
  return [
    ...catalog.repositories.map((row) => ({
      kind: 'repository' as const,
      id: row.id,
      label: row.displayName
    })),
    ...catalog.folderWorkspaces.map((row) => ({
      kind: 'folder-workspace' as const,
      id: row.id,
      label: row.name
    })),
    ...catalog.projectGroups.map((row) => ({
      kind: 'project-group' as const,
      id: row.id,
      label: row.name
    }))
  ]
}

/** Rows earlier migrations moved that an older build has since changed or removed. */
function notReflected(
  current: KingudMigrationCatalogPayload,
  movedPayloads: readonly KingudMigrationCatalogPayload[]
): KingudDeltaMovePreview['notReflected'] {
  const latestMoved = new Map<string, { row: KingudDeltaMoveRow; identity: string }>()
  for (const payload of movedPayloads) {
    for (const row of catalogRows(payload)) {
      latestMoved.set(`${row.kind}:${row.id}`, { row, identity: identityOf(payload, row) })
    }
  }
  const currentByKey = new Map(
    catalogRows(current).map((row) => [`${row.kind}:${row.id}`, identityOf(current, row)])
  )
  const edited: KingudDeltaMoveRow[] = []
  const removed: KingudDeltaMoveRow[] = []
  for (const [key, moved] of latestMoved) {
    const identity = currentByKey.get(key)
    if (identity === undefined) {
      removed.push(moved.row)
    } else if (identity !== moved.identity) {
      edited.push(moved.row)
    }
  }
  return { edited, removed }
}

function identityOf(catalog: KingudMigrationCatalogPayload, row: KingudDeltaMoveRow): string {
  switch (row.kind) {
    case 'repository': {
      const repo = catalog.repositories.find((entry) => entry.id === row.id)
      return `${repo?.path}\0${repo?.displayName}`
    }
    case 'folder-workspace': {
      const folder = catalog.folderWorkspaces.find((entry) => entry.id === row.id)
      return `${folder?.folderPath}\0${folder?.name}`
    }
    case 'project-group':
      return catalog.projectGroups.find((entry) => entry.id === row.id)?.name ?? ''
  }
}
