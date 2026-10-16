/** The relay-era SSH target as a migration source: keyed by its target id, paths unchanged. */
import { KINGUD_MIGRATION_SSH_RELAY_SOURCE_KIND } from '../../shared/kingud-migration-source-kind'
import type { SshTarget } from '../../shared/ssh-types'
import { collectKingudMigrationSourceCatalog } from '../persistence/migrating-kingud-catalog/kingud-source-catalog'
import type { Store } from '../persistence'
import { createKingudMigrationManifest } from './kingud-migration-manifest-export'
import { IDENTITY_KINGUD_MIGRATION_PATH_REWRITER } from './kingud-migration-path-rewrite'
import type {
  KingudMigrationSource,
  KingudMigrationSourceCutoverPort
} from './kingud-migration-source'
import { assertKingudMigrationSourceUnchanged } from './kingud-migration-source-assertions'
import {
  fenceKingudMigrationSource,
  releaseKingudMigrationFence,
  resolveKingudMigrationFence
} from './kingud-migration-source-fence'
import { retainKingudMigrationSource } from './kingud-migration-source-retention'
import {
  assessKingudMigrationTerminals,
  retireProvenExitedLeases,
  type CensusHostRelayTerminals
} from './kingud-migration-terminal-gate'
import type { SshTargetKingudClaims } from './ssh-target-kingud-claims'
import type { KingudMigrationPreflightStore } from './ssh-target-kingud-preflight'

type SshRelayCutoverDeps = {
  userDataPath: string
  store: KingudMigrationPreflightStore
  claims: SshTargetKingudClaims
  /** Rebuilt for every check when `store` is a copy that would never see a later edit. */
  freshSource?: () => KingudMigrationPreflightStore
  signal?: AbortSignal
}

/** The fenced SSH target a journaled cutover names. */
export function sshRelayMigrationCutoverPort(
  deps: SshRelayCutoverDeps
): KingudMigrationSourceCutoverPort {
  return {
    verifyFence: (cutover) =>
      assertKingudMigrationSourceUnchanged(
        { userDataPath: deps.userDataPath, store: deps.freshSource?.() ?? deps.store },
        cutover
      ),
    releaseFence: (cutover) => releaseKingudMigrationFence(deps, cutover),
    retireAfterCommit: (migrationId, now) =>
      retainKingudMigrationSource(deps.userDataPath, migrationId, now)
  }
}

export function createSshRelayMigrationSource(
  deps: SshRelayCutoverDeps & {
    store: KingudMigrationPreflightStore &
      Pick<Store, 'getSshRemotePtyLeases' | 'markSshRemotePtyLease'>
    target: SshTarget
    /** Every relay endpoint on the host's account; without it exit can never be proven. */
    censusHost?: CensusHostRelayTerminals | null
  }
): KingudMigrationSource {
  const { userDataPath, store, target } = deps
  return {
    ...sshRelayMigrationCutoverPort(deps),
    kind: KINGUD_MIGRATION_SSH_RELAY_SOURCE_KIND,
    journalKey: target.id,
    collectCatalog: () => collectKingudMigrationSourceCatalog(store, target),
    exportManifest: (options = {}) =>
      createKingudMigrationManifest(store, target, {
        ...options,
        rewrite: IDENTITY_KINGUD_MIGRATION_PATH_REWRITER
      }),
    assessTerminals: () => assessKingudMigrationTerminals(store, target.id, deps.censusHost),
    retireProvenExitedTerminals: (proof) => retireProvenExitedLeases(store, target.id, proof),
    resolveFence: () => resolveKingudMigrationFence(userDataPath, target),
    acquireFence: (args) =>
      fenceKingudMigrationSource({
        userDataPath,
        store,
        claims: deps.claims,
        targetId: target.id,
        ...args
      })
  }
}
