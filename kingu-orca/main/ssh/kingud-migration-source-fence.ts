/**
 * Fencing a relay-hosted SSH target for a dormant migration into a managed kingud.
 *
 * Two durable records describe a fence: the journal sidecar and the target's `kingudFence`.
 * Write order is journal, then fence, then the profile flush, all before any remote call, so a
 * crash leaves either nothing, a journal without a fence (stale, never authority), or both.
 * A fence without a journal is never released here: only the destination can say what happened.
 */
import { randomUUID } from 'node:crypto'
import { getManagedKingudFenceEnvironmentId } from '../../shared/managed-kingud-ssh-owner'
import type { KingudMigrationBlocker } from '../../shared/kingud-migration-preflight'
import {
  KINGUD_MIGRATION_SOURCE_CUTOVER_VERSION,
  type KingudMigrationSourceCutover
} from '../../shared/kingud-migration-source-cutover'
import type { SshTarget } from '../../shared/ssh-types'
import { createKingudMigrationManifest } from './kingud-migration-manifest-export'
import {
  findKingudMigrationSourceCutoverForTarget,
  removeKingudMigrationSourceCutover,
  writeKingudMigrationSourceCutover
} from './kingud-migration-cutover-journal'
import {
  confirmKingudMigrationTerminalsUnderFence,
  type KingudMigrationTerminalVerdict
} from './kingud-migration-terminal-gate'
import type { SshTargetKingudClaims } from './ssh-target-kingud-claims'
import {
  isBlockingKingudMigrationBlocker,
  preflightKingudMigrationExport,
  type KingudMigrationPreflightStore
} from './ssh-target-kingud-preflight'
import { kingudMigrationRefusalReason } from './kingud-migration-refusal-reason'

export const KINGUD_MIGRATION_LEAVE_BEHIND_TERMINALS = 'kingud_migration_leave_behind_terminals'
export const KINGUD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON =
  'Move anyway needs every terminal on this host closed first, and Kingu could not confirm they all exited. Close them, or end them on the host, then connect again.'

export type KingudMigrationFenceState =
  | { state: 'none' }
  /** Owner and journal agree: the migration can resume. */
  | { state: 'fenced'; cutover: KingudMigrationSourceCutover }
  /** Owned by an empty-host deploy, which records itself as a provisioning intent instead. */
  | { state: 'owned-by-deploy'; environmentId: string }
  /** Owner with no journal (a downgrade dropped it, or it never landed): recover, never release. */
  | { state: 'fenced-unverifiable'; environmentId: string }
  /** Journal whose fence is gone or changed: it can never authorize staging. */
  | { state: 'stale-journal'; cutover: KingudMigrationSourceCutover }

/** Throws when the journal cannot be read: an unreadable record keeps the host fenced. */
export function resolveKingudMigrationFence(
  userDataPath: string,
  target: SshTarget
): KingudMigrationFenceState {
  const cutover = findKingudMigrationSourceCutoverForTarget(userDataPath, target.id)
  const ownerEnvironmentId = getManagedKingudFenceEnvironmentId(target)
  if (cutover) {
    return ownerEnvironmentId === cutover.destinationEnvironmentId &&
      target.generation === cutover.sshTargetGeneration
      ? { state: 'fenced', cutover }
      : { state: 'stale-journal', cutover }
  }
  if (!ownerEnvironmentId) {
    return { state: 'none' }
  }
  return target.kingudProvisioning
    ? { state: 'owned-by-deploy', environmentId: ownerEnvironmentId }
    : { state: 'fenced-unverifiable', environmentId: ownerEnvironmentId }
}

export type KingudMigrationFenceResult =
  | { outcome: 'fenced'; cutover: KingudMigrationSourceCutover; resumed: boolean }
  | {
      outcome: 'refused'
      verdict: 'live' | 'unverifiable'
      code: string
      reason: string
      blockers?: KingudMigrationBlocker[]
    }

export async function fenceKingudMigrationSource(args: {
  userDataPath: string
  store: KingudMigrationPreflightStore
  claims: SshTargetKingudClaims
  targetId: string
  destinationEnvironmentId: string
  destinationName: string
  /** Taken by the caller while the relay could still answer; see kingud-migration-terminal-gate. */
  terminalProof: KingudMigrationTerminalVerdict
  now?: () => Date
  signal?: AbortSignal
}): Promise<KingudMigrationFenceResult> {
  const target = args.store.getSshTarget(args.targetId)
  if (!target) {
    return refuse('unverifiable', 'kingud_migration_target_not_found', 'The SSH host is gone.')
  }
  const existing = resolveKingudMigrationFence(args.userDataPath, target)
  if (existing.state === 'fenced') {
    return existing.cutover.destinationEnvironmentId === args.destinationEnvironmentId
      ? { outcome: 'fenced', cutover: existing.cutover, resumed: true }
      : refuse('live', 'kingud_migration_in_progress', 'Another migration holds this SSH host.')
  }
  if (existing.state !== 'none') {
    return refuse(
      'unverifiable',
      `kingud_migration_${existing.state.replaceAll('-', '_')}`,
      fenceStateReason(existing)
    )
  }
  const proof = args.terminalProof
  if (proof.verdict !== 'exited' && proof.verdict !== 'bridged') {
    return refuse(proof.verdict, 'kingud_migration_terminals', proof.reason)
  }
  if (proof.verdict === 'bridged' && target.managedServerLeaveBehind) {
    // Why: leaving the saved tabs behind drops the identities the relay bridge reattaches through.
    return refuse(
      proof.relayVerdict,
      KINGUD_MIGRATION_LEAVE_BEHIND_TERMINALS,
      KINGUD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON
    )
  }
  const preflight = preflightKingudMigrationExport(
    args.store,
    target.id,
    undefined,
    proof.verdict === 'bridged' ? proof.bridgedPtyIds : []
  )
  if (!preflight.claimable) {
    return {
      ...refuse(
        // Only a proven blocker reads live; one that is merely unanswered stays unverifiable.
        preflight.blockers
          .filter(isBlockingKingudMigrationBlocker)
          .every((blocker) => blocker.category === 'live-or-unverifiable')
          ? 'unverifiable'
          : 'live',
        'kingud_migration_preflight_blocked',
        kingudMigrationRefusalReason(preflight.blockers)
      ),
      blockers: preflight.blockers
    }
  }
  const generation = args.claims.ensureGeneration(target.id)
  const now = (args.now ?? (() => new Date()))().toISOString()
  const manifest = createKingudMigrationManifest(
    args.store,
    { ...target, generation },
    { migrationId: randomUUID(), destinationEnvironmentId: args.destinationEnvironmentId }
  )
  const cutover: KingudMigrationSourceCutover = {
    version: KINGUD_MIGRATION_SOURCE_CUTOVER_VERSION,
    migrationId: manifest.migrationId,
    phase: 'source-fenced',
    startedAt: now,
    updatedAt: now,
    destinationEnvironmentId: args.destinationEnvironmentId,
    destinationName: args.destinationName,
    sshTargetId: target.id,
    sshTargetGeneration: generation,
    manifestSha256: manifest.manifestSha256,
    provenPtyIds: proof.verdict === 'exited' ? proof.provenPtyIds : [],
    ...(proof.verdict === 'bridged' ? { bridgedPtyIds: proof.bridgedPtyIds } : {}),
    // Taken with the export, before any commit is possible: the only proof of what the server holds.
    manifest
  }
  writeKingudMigrationSourceCutover(args.userDataPath, cutover)
  args.claims.fenceForMigration(target.id, args.destinationEnvironmentId, generation)
  await args.claims.flush(args.signal)
  // Why again: a terminal may have started between the proof and the fence.
  const underFence = confirmKingudMigrationTerminalsUnderFence(
    args.store,
    target.id,
    args.terminalProof
  )
  if (underFence.verdict !== 'exited' && underFence.verdict !== 'bridged') {
    await releaseUnstagedFence(args, cutover)
    return refuse(underFence.verdict, 'kingud_migration_terminals', underFence.reason)
  }
  return { outcome: 'fenced', cutover, resumed: false }
}

type FenceReleaseArgs = {
  userDataPath: string
  claims: SshTargetKingudClaims
  signal?: AbortSignal
}

/** Undoes a fence nothing remote has seen. */
export async function releaseUnstagedFence(
  args: FenceReleaseArgs,
  cutover: KingudMigrationSourceCutover
): Promise<void> {
  if (cutover.phase !== 'source-fenced') {
    throw new Error('kingud_migration_fence_release_after_stage')
  }
  await releaseKingudMigrationFence(args, cutover)
}

/**
 * Owner first, then the journal: a crash between them leaves a stale journal, which grants
 * nothing, rather than an owner nothing explains.
 */
export async function releaseKingudMigrationFence(
  args: FenceReleaseArgs,
  cutover: KingudMigrationSourceCutover
): Promise<void> {
  args.claims.release(cutover.sshTargetId, cutover.destinationEnvironmentId)
  await args.claims.flush(args.signal)
  removeKingudMigrationSourceCutover(args.userDataPath, cutover.migrationId)
}

/**
 * Releases a migration fence whose destination server was never registered: no deploy finished,
 * so nothing could have been staged there. A registered destination must answer an abort instead.
 */
export async function releaseUndeployedMigrationFence(args: {
  userDataPath: string
  claims: SshTargetKingudClaims
  targetId: string
  isDestinationRegistered: (environmentId: string) => boolean
  signal?: AbortSignal
}): Promise<'released' | 'none'> {
  const cutover = findKingudMigrationSourceCutoverForTarget(args.userDataPath, args.targetId)
  if (!cutover) {
    return 'none'
  }
  if (args.isDestinationRegistered(cutover.destinationEnvironmentId)) {
    throw new Error('kingud_migration_destination_registered')
  }
  await releaseUnstagedFence(args, cutover)
  return 'released'
}

function fenceStateReason(state: KingudMigrationFenceState): string {
  switch (state.state) {
    case 'owned-by-deploy':
      return 'This SSH host already belongs to a managed server.'
    case 'fenced-unverifiable':
      return 'This SSH host is held for a migration whose record is missing. Recover it from the managed server first.'
    case 'stale-journal':
      return 'A migration record names this SSH host but its fence is gone. Resolve that migration first.'
    case 'fenced':
    case 'none':
      return 'This SSH host is not in a state a migration can start from.'
  }
}

function refuse(
  verdict: 'live' | 'unverifiable',
  code: string,
  reason: string
): Extract<KingudMigrationFenceResult, { outcome: 'refused' }> {
  return { outcome: 'refused', verdict, code, reason }
}
