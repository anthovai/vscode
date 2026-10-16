/**
 * Can this relay-hosted SSH target's state be exported to a managed kingud?
 *
 * Unlike claiming an empty target, export carries the target's repositories, folder
 * workspaces and the dormant state the manifest can represent, so those drain rather than block.
 * What blocks is what cannot move: another owner, live terminal leases, and dependent state the
 * manifest cannot carry. Read-only: building the manifest here exports nothing.
 */
import { isLiveSshPtyLease } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import type {
  KingudMigrationBlocker,
  KingudMigrationPreflight
} from '../../shared/kingud-migration-preflight'
import {
  createKingudMigrationManifest,
  type KingudMigrationExportStore
} from './kingud-migration-manifest-export'
import {
  collectTargetCatalogBlockers,
  resolveKingudPreflightTarget
} from './ssh-target-kingud-claims'
import { collectUntransferredDependentBlockers } from './ssh-target-kingud-dependents'

export type KingudMigrationPreflightStore = KingudMigrationExportStore &
  Pick<
    Store,
    'getSshTarget' | 'getSshRemotePtyLeases' | 'inspectKingudMigrationUntransferredDependencies'
  >

/** `owner` passes the environment's own fence only when its migration journal is on disk. */
export function preflightKingudMigrationExport(
  store: KingudMigrationPreflightStore,
  targetId: string,
  owner?: { environmentId: string; recorded: boolean },
  /** COMPAT(legacy-relay-bridge): leases a bridged proof left running for the bridge. */
  bridgedPtyIds: readonly string[] = []
): KingudMigrationPreflight {
  const resolved = resolveKingudPreflightTarget(store, targetId, owner)
  if ('result' in resolved) {
    return resolved.result
  }
  const { target } = resolved
  const blockers: KingudMigrationBlocker[] = [...collectTargetCatalogBlockers(store, target)]
  const terminalLeases = store
    .getSshRemotePtyLeases(targetId)
    .filter((lease) => isLiveSshPtyLease(lease) && !bridgedPtyIds.includes(lease.ptyId))
    .map(({ ptyId, worktreeId, tabId, leafId, state, updatedAt }) => ({
      ptyId,
      worktreeId,
      tabId,
      leafId,
      state,
      updatedAt
    }))
  if (terminalLeases.length > 0) {
    // A relay PTY cannot move to kingud; its work must finish first.
    blockers.push({
      code: 'kingud_migration_direct_ssh_terminal_leases',
      category: 'live-or-unverifiable',
      terminalLeases
    })
  }
  blockers.push(
    ...collectUntransferredDependentBlockers(store, createKingudMigrationManifest(store, target))
  )
  return {
    targetId,
    targetLabel: target.label,
    claimable: !blockers.some(isBlockingKingudMigrationBlocker),
    blockers
  }
}

/** Whether a confirmed "Move anyway" would export: what it can't leave (desktop drafts) still refuses. */
export function leaveBehindClearsKingudMigrationBlockers(
  store: KingudMigrationPreflightStore & Pick<Store, 'createKingudMigrationLeaveBehindView'>,
  targetId: string
): boolean {
  const view = store.createKingudMigrationLeaveBehindView(targetId)
  return preflightKingudMigrationExport(
    {
      ...view,
      getSshTarget: (id) => store.getSshTarget(id),
      getSshRemotePtyLeases: (id) => store.getSshRemotePtyLeases(id)
    },
    targetId
  ).claimable
}

/** Only saved state blocks: a confirmed "Move anyway" may leave it on this desktop. */
export function onlyLeavableKingudMigrationBlockers(
  blockers: readonly KingudMigrationBlocker[]
): boolean {
  const blocking = blockers.filter(isBlockingKingudMigrationBlocker)
  return (
    blocking.length > 0 &&
    blocking.every((blocker) => blocker.code === 'kingud_migration_dependent_state')
  )
}

// Exported catalog rows and saved port forwards (which stay with the source) do not block.
export function isBlockingKingudMigrationBlocker(blocker: KingudMigrationBlocker): boolean {
  return (
    blocker.category !== 'drainable-static-state' &&
    blocker.code !== 'kingud_migration_saved_port_forwards'
  )
}
