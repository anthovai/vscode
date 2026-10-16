/**
 * Putting a host back to the slot and state it had before an activation or rollback.
 *
 * Shared by the in-flight failure paths and by crash recovery, so both apply one rule: state
 * a launched slot may have changed is replaced only after that slot is proven exited, and only
 * when an operator accepts it — the slot exposed RPC, and with it stopped nothing on the host
 * can count the terminals it started, so the snapshot may no longer describe them.
 */
import { execKingudStateMutation } from './kingud-state-mutation-exec'
import { kingudRemoteBaseDir } from './kingud-remote-windows-node'
import type { ServeReadiness } from '../server/serve-readiness'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { KINGUD_STATE_SNAPSHOT_DIR } from './kingud-activation-record'
import type { KingudSnapshotVerdict } from './kingud-activation-transaction'
import {
  clearKingudStateSnapshotMembersCommand,
  compareKingudStateSnapshotCommand,
  kingudSnapshotIsUnchanged,
  parseKingudSnapshotRestore,
  restoreKingudStateSnapshotCommand
} from './kingud-state-snapshot'
import { execKingudRemote } from './kingud-remote-runtime-control'
import {
  ensureKingudSlotServing,
  launchKingudSlot,
  quiesceInterruptedKingudSlot,
  type KingudSlotIdentity,
  type KingudSlotOptions
} from './kingud-recovery-slot'
import { joinRemotePath } from './ssh-remote-platform'
import { KINGUD_RECOVERY_CHANGED_STATE_CODE } from '../../shared/kingud-managed-runtime'

export type KingudIncumbentRecoveryOptions = KingudSlotOptions & {
  /** The operator accepted restoring the snapshot over state a launched build changed. */
  acceptChangedState?: boolean
}

export type KingudIncumbentRecovery =
  | { outcome: 'restored'; readiness: ServeReadiness | null }
  | { outcome: 'refused'; verdict: 'live' | 'unverifiable'; code: string; reason: string }

export function kingudSnapshotPath(options: KingudSlotOptions, dirName: string): string {
  return joinRemotePath(
    options.host,
    options.remoteHome,
    RELAY_REMOTE_DIR,
    KINGUD_STATE_SNAPSHOT_DIR,
    dirName
  )
}

/** Throws when a step cannot be verified; the caller keeps the fence. */
export async function recoverKingudIncumbent(
  options: KingudIncumbentRecoveryOptions,
  input: {
    transactionStartedAt: string
    launchedVersion: string | null
    incumbent: KingudSlotIdentity | null
    restoreState: KingudSnapshotVerdict | null
    /** The state the launched slot started from, when that is not `restoreState` (a rollback). */
    launchedFromState?: KingudSnapshotVerdict | null
    /** This run itself proved both slots exited, so no fresh liveness probe is needed. */
    slotsProvenExited?: boolean
  }
): Promise<KingudIncumbentRecovery> {
  const quiescence =
    input.slotsProvenExited || !input.restoreState
      ? 'exited'
      : await quiesceInterruptedKingudSlot(options, input.launchedVersion, input.incumbent)
  // With no incumbent there is no older reader to protect; the record names nothing to serve.
  if (quiescence === 'exited' && input.restoreState && input.incumbent) {
    const decision = input.launchedVersion
      ? await decideChangedStateRestore(options, input.launchedFromState ?? input.restoreState)
      : 'restore'
    if (decision !== 'restore' && decision !== 'unchanged') {
      return decision
    }
    // A launched slot that left its starting state untouched still sits on a root to replace.
    if (decision === 'restore' || input.launchedFromState) {
      await restoreState(options, input.restoreState)
    }
  }
  if (!input.incumbent) {
    return { outcome: 'restored', readiness: null }
  }
  return {
    outcome: 'restored',
    readiness: input.slotsProvenExited
      ? await launchKingudSlot(options, input.incumbent)
      : await ensureKingudSlotServing(options, input.incumbent)
  }
}

async function decideChangedStateRestore(
  options: KingudIncumbentRecoveryOptions,
  state: KingudSnapshotVerdict
): Promise<'unchanged' | 'restore' | Extract<KingudIncumbentRecovery, { outcome: 'refused' }>> {
  if (state.state === 'captured') {
    const snapshotDir = kingudSnapshotPath(options, state.dirName)
    // Read-only, so a lost answer is just "changed".
    const comparison = await execKingudRemote(
      options,
      compareKingudStateSnapshotCommand(
        options.host,
        options.userDataDir,
        snapshotDir,
        kingudRemoteBaseDir(options.host, options.remoteHome)
      )
    ).catch(() => '')
    if (kingudSnapshotIsUnchanged(comparison)) {
      return 'unchanged'
    }
  }
  if (options.acceptChangedState) {
    return 'restore'
  }
  const retained =
    state.state === 'captured' ? ` at ${kingudSnapshotPath(options, state.dirName)}` : ''
  return {
    outcome: 'refused',
    verdict: 'unverifiable',
    code: KINGUD_RECOVERY_CHANGED_STATE_CODE,
    reason:
      'The launched build is stopped, but it changed profile state (or the change could not be ' +
      'checked), so the previous build was not restarted against it and this host serves ' +
      'nothing. Recover to restore the prelaunch snapshot' +
      `${retained} and restart the previous build; terminals the launched build started keep ` +
      'running but drop out of the restored state.'
  }
}

async function restoreState(
  options: KingudSlotOptions,
  state: KingudSnapshotVerdict
): Promise<void> {
  if (state.state === 'pending') {
    throw new Error('The interrupted transaction has no durable snapshot verdict.')
  }
  const command =
    state.state === 'captured'
      ? restoreKingudStateSnapshotCommand(
          options.host,
          options.userDataDir,
          kingudSnapshotPath(options, state.dirName),
          kingudRemoteBaseDir(options.host, options.remoteHome)
        )
      : clearKingudStateSnapshotMembersCommand(
          options.host,
          options.userDataDir,
          kingudRemoteBaseDir(options.host, options.remoteHome)
        )
  const restored = parseKingudSnapshotRestore(await execKingudStateMutation(options, command))
  if (restored !== 'restored') {
    throw new Error(`The prelaunch state could not be restored (${restored}).`)
  }
}
