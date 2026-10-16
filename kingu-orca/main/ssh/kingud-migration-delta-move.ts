/**
 * The delta move: a fresh, journaled conversion of only what an older build added to a converted
 * host, committed to the same managed server. Its journal supersedes the previous head of the
 * host's chain; both stay, and the source rows of every manifest in the chain are kept.
 *
 * A row the server already holds under another identity fails the whole move at stage, before
 * anything is committed: the journal goes, and the host keeps its "changed" mark and the relay.
 * A move whose outcome the server can't confirm keeps its journal, and the next move resumes it.
 */
import {
  KINGUD_MIGRATION_SOURCE_CUTOVER_VERSION,
  type KingudMigrationSourceCutover
} from '../../shared/kingud-migration-source-cutover'
import type { KingudDeltaMoveResult } from '../../shared/kingud-managed-runtime'
import { recordManagedKingudMigration } from '../../shared/runtime-environment-managed-kingud-store'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import {
  abortKingudMigrationCutover,
  commitKingudMigrationDestination,
  type KingudMigrationCutoverContext,
  type KingudMigrationDestinationCatalog
} from './kingud-migration-cutover-coordinator'
import {
  findKingudMigrationSourceCutoverForTarget,
  listKingudMigrationCutoverChainForTarget,
  removeKingudMigrationSourceCutover,
  writeKingudMigrationSourceCutover
} from './kingud-migration-cutover-journal'
import {
  committedKingudMigrationChain,
  kingudDeltaSourceStore,
  planKingudDeltaMove,
  unfinishedKingudDelta,
  type KingudDeltaMovePlan
} from './kingud-migration-delta-plan'
import { retainKingudMigrationSource } from './kingud-migration-source-retention'
import {
  assessKingudMigrationTerminals,
  type KingudMigrationTerminalVerdict,
  retireProvenExitedLeases,
  type CensusHostRelayTerminals
} from './kingud-migration-terminal-gate'
import { currentKingudSourceFingerprint } from './kingud-retained-source'
import type { SshTargetKingudClaims } from './ssh-target-kingud-claims'
import { kingudMigrationRefusalReason } from './kingud-migration-refusal-reason'
import { errorMessage } from '../../shared/error-message'

export type KingudDeltaMoveArgs = {
  userDataPath: string
  store: Store
  claims: SshTargetKingudClaims
  target: SshTarget
  environment: KnownRuntimeEnvironment
  destination: KingudMigrationDestinationCatalog
  /** The census of the host's relay endpoints that must prove exit. */
  censusHost?: CensusHostRelayTerminals | null
  ensureTunnel: () => Promise<void>
  /** Serializes the journal write through the commit with every other change to this host. */
  runTargetLifecycle: <T>(targetId: string, operation: () => Promise<T>) => Promise<T>
  now?: () => Date
}

export async function runKingudDeltaMove(
  args: KingudDeltaMoveArgs
): Promise<KingudDeltaMoveResult> {
  const { userDataPath, store, target } = args
  const now = args.now ?? (() => new Date())
  const plan = planKingudDeltaMove(userDataPath, store, target, { now })
  // Taken with the manifest, before any await: the baseline must describe what the server receives.
  const planned = currentKingudSourceFingerprint(store, target)
  if (!plan.resumes && plan.added.length === 0) {
    return refuse('kingud_delta_nothing_new', 'An older build added nothing new to move.')
  }
  if (plan.blockers.length > 0) {
    return {
      ...refuse('kingud_migration_preflight_blocked', kingudMigrationRefusalReason(plan.blockers)),
      blockers: plan.blockers
    }
  }
  const terminals = await assessKingudMigrationTerminals(store, target.id, args.censusHost)
  if (terminals.verdict !== 'exited' && terminals.verdict !== 'bridged') {
    return refuse('kingud_migration_terminals', terminals.reason)
  }
  const settled: SettledTerminals = terminals
  retireProvenExitedLeases(store, target.id, terminals)
  return args.runTargetLifecycle(target.id, async () => {
    // Why re-checked: another move of this host may have journaled or finished while this waited.
    const changedAt = store.getSshTarget(target.id)?.kingudFence?.sourceChangedAt
    const head = findKingudMigrationSourceCutoverForTarget(userDataPath, target.id)
    if (!changedAt || head?.migrationId !== (plan.resumes ?? plan.head).migrationId) {
      return refuse('kingud_delta_superseded', 'Another move of this host ran first.')
    }
    // The source stays writable until the fence below: a draft typed while the terminals were
    // checked is newer than the manifest, so it must not become the baseline the server is held to.
    if (!plan.resumes && planned !== currentKingudSourceFingerprint(store, target)) {
      return refuse(
        'kingud_delta_source_changed',
        'This host changed while the move was starting. Try the move again.'
      )
    }
    const cutover = plan.resumes ?? journalDelta(args, plan, planned, settled, now)
    return commitDelta(args, plan, cutover, changedAt, now)
  })
}

type SettledTerminals = Extract<KingudMigrationTerminalVerdict, { verdict: 'exited' | 'bridged' }>

function journalDelta(
  args: KingudDeltaMoveArgs,
  plan: KingudDeltaMovePlan,
  planned: string,
  terminals: SettledTerminals,
  now: () => Date
): KingudMigrationSourceCutover {
  const timestamp = now().toISOString()
  const cutover: KingudMigrationSourceCutover = {
    version: KINGUD_MIGRATION_SOURCE_CUTOVER_VERSION,
    migrationId: plan.manifest.migrationId,
    phase: 'source-fenced',
    startedAt: timestamp,
    updatedAt: timestamp,
    destinationEnvironmentId: plan.environmentId,
    destinationName: plan.head.destinationName,
    sshTargetId: args.target.id,
    sshTargetGeneration: plan.head.sshTargetGeneration,
    manifestSha256: plan.manifest.manifestSha256,
    provenPtyIds: terminals.verdict === 'exited' ? terminals.provenPtyIds : [],
    // COMPAT(legacy-relay-bridge): a move leaves relay terminals running for the bridge too.
    ...(terminals.verdict === 'bridged' ? { bridgedPtyIds: terminals.bridgedPtyIds } : {}),
    supersedesMigrationId: plan.head.migrationId,
    // The whole source as the manifest saw it: what the retained rows must keep matching.
    sourceBaselineFingerprint: planned,
    manifest: plan.manifest
  }
  writeKingudMigrationSourceCutover(args.userDataPath, cutover)
  return cutover
}

async function commitDelta(
  args: KingudDeltaMoveArgs,
  plan: KingudDeltaMovePlan,
  cutover: KingudMigrationSourceCutover,
  changedAt: string,
  now: () => Date
): Promise<KingudDeltaMoveResult> {
  const { userDataPath, store, target } = args
  // The fence goes back without its "changed" mark: the source freezes for the move.
  store.updateSshTarget(target.id, { kingudFence: { environmentId: plan.environmentId } })
  await args.claims.flush()
  const context: KingudMigrationCutoverContext = {
    userDataPath,
    store: plan.source,
    freshSource: () => kingudDeltaSourceStore(store, target, plan.moved),
    claims: args.claims,
    destination: args.destination,
    now
  }
  // Before any commit can land, resumed ones included: a rollback must not cross this move.
  recordManagedKingudMigration(userDataPath, plan.environmentId, now().toISOString())
  try {
    await args.ensureTunnel()
    const committed = await commitKingudMigrationDestination(context, cutover.migrationId)
    if (committed.phase !== 'destination-committed' && committed.phase !== 'source-retired') {
      throw new Error(`kingud_migration_commit_not_proven:${committed.phase}`)
    }
  } catch (error) {
    const released = await releaseUncommittedDelta(args, context, cutover, changedAt)
    if (released === 'released') {
      return refuse('kingud_delta_refused_by_server', errorMessage(error))
    }
    if (released === 'kept') {
      throw error
    }
  }
  retainKingudMigrationSource(userDataPath, cutover.migrationId, now)
  return { outcome: 'moved', migrationId: cutover.migrationId }
}

/**
 * Undoes a delta only once the server provably holds nothing of it, so no row moves twice. One it
 * may hold stays journaled for the next move to resume; either way the host gets its mark back.
 */
async function releaseUncommittedDelta(
  args: KingudDeltaMoveArgs,
  context: KingudMigrationCutoverContext,
  cutover: KingudMigrationSourceCutover,
  changedAt: string
): Promise<'released' | 'committed' | 'kept'> {
  const restoreMark = async (): Promise<void> => {
    args.store.updateSshTarget(cutover.sshTargetId, {
      kingudFence: { environmentId: cutover.destinationEnvironmentId, sourceChangedAt: changedAt }
    })
    await args.claims.flush()
  }
  try {
    const result = await abortKingudMigrationCutover(context, cutover.migrationId, async () => {
      // Mark first: a crash before the journal goes leaves a marked host that resumes this delta.
      await restoreMark()
      removeKingudMigrationSourceCutover(args.userDataPath, cutover.migrationId)
    })
    return result.outcome === 'released' ? 'released' : 'committed'
  } catch {
    await restoreMark()
    return 'kept'
  }
}

/** "Keep the server's version": the older build's changes stay only in the retained profile rows. */
export async function keepKingudServerVersion(args: {
  userDataPath: string
  store: Store
  claims: SshTargetKingudClaims
  target: SshTarget
}): Promise<void> {
  const environmentId = args.target.kingudFence?.environmentId
  const chain = listKingudMigrationCutoverChainForTarget(args.userDataPath, args.target.id)
  if (unfinishedKingudDelta(chain)) {
    // Its rows may be on the server already; only finishing or undoing the move can say.
    throw new Error('kingud_delta_move_unfinished')
  }
  const head = committedKingudMigrationChain(chain).at(-1)
  if (!environmentId || !args.target.kingudFence?.sourceChangedAt || !head) {
    throw new Error('kingud_delta_not_changed')
  }
  writeKingudMigrationSourceCutover(args.userDataPath, {
    ...head,
    // Keeping the server's version is the explicit reconcile: the source as it is now is the baseline.
    sourceBaselineFingerprint: currentKingudSourceFingerprint(args.store, args.target)
  })
  args.store.updateSshTarget(args.target.id, { kingudFence: { environmentId } })
  await args.claims.flush()
}

function refuse(
  code: string,
  reason: string
): Extract<KingudDeltaMoveResult, { outcome: 'refused' }> {
  return { outcome: 'refused', code, reason }
}
