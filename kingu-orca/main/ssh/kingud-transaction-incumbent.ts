/** The incumbent slot across a journaled activation or rollback: stop it, then put it back. */
import type { KingudActivationLockControl } from './kingud-activation-lock'
import type { KingudSnapshotVerdict } from './kingud-activation-transaction'
import { kingudStopFreedTheHost } from './kingud-remote-process-control'
import { withoutAbortSignal } from './kingud-remote-runtime-control'
import {
  launchKingudSlot,
  stopKingudSlot,
  KINGUD_SLOT_STOP_WAIT_SECONDS,
  type KingudSlotIdentity,
  type KingudSlotOptions
} from './kingud-recovery-slot'
import { recoverKingudIncumbent } from './kingud-incumbent-recovery'
import { errorMessage } from '../../shared/error-message'

/** Null once the incumbent provably exited; otherwise why not, with the fence kept if it may still change. */
export async function stopTransactionIncumbent(
  options: KingudSlotOptions,
  incumbent: KingudSlotIdentity,
  lock: KingudActivationLockControl
): Promise<string | null> {
  const stopped = await stopKingudSlot(options, incumbent.remoteDir, false)
  if (kingudStopFreedTheHost(stopped)) {
    return null
  }
  // Only a stop that may have been delivered can still change the host; otherwise nothing happened.
  if (stopped === 'still-running' || stopped === 'unconfirmed') {
    lock.retain()
  }
  return (
    `Could not verify that kingud ${incumbent.version} exited within ` +
    `${KINGUD_SLOT_STOP_WAIT_SECONDS}s (${stopped}).`
  )
}

export async function restartAfterSnapshotFailure(
  options: KingudSlotOptions,
  incumbent: KingudSlotIdentity,
  lock: KingudActivationLockControl
): Promise<string> {
  try {
    await launchKingudSlot(withoutAbortSignal(options), incumbent)
    lock.recovered()
    return `kingud ${incumbent.version} was restarted and is serving again.`
  } catch (error) {
    lock.retain()
    return `restarting kingud ${incumbent.version} failed: ${errorMessage(error)} This host requires recovery.`
  }
}

/**
 * Restores `restoreState` when it was replaced, then restarts the incumbent; both slots are
 * already proven exited. Null on success; otherwise why not, with the fence kept.
 */
export async function putTransactionIncumbentBack(
  options: KingudSlotOptions,
  lock: KingudActivationLockControl,
  input: {
    transactionStartedAt: string
    launchedVersion: string | null
    incumbent: KingudSlotIdentity | null
    restoreState: KingudSnapshotVerdict | null
    launchedFromState?: KingudSnapshotVerdict | null
  }
): Promise<string | null> {
  try {
    const recovery = await recoverKingudIncumbent(withoutAbortSignal(options), {
      ...input,
      slotsProvenExited: true
    })
    if (recovery.outcome === 'refused') {
      lock.retain()
      return recovery.reason
    }
    lock.recovered()
    return null
  } catch (error) {
    lock.retain()
    return `Restoring the previous version failed: ${errorMessage(error)} This host requires recovery.`
  }
}

/** Stop the build this run launched, then put the incumbent back only on safe state. */
export async function restoreAfterRejectedCandidate(
  options: KingudSlotOptions,
  lock: KingudActivationLockControl,
  input: {
    launchedDir: string
    launchedVersion: string
    transactionStartedAt: string
    incumbent: KingudSlotIdentity | null
    restoreState: KingudSnapshotVerdict | null
    launchedFromState?: KingudSnapshotVerdict | null
  }
): Promise<string> {
  const { launchedDir, ...restore } = input
  const stopped = await stopKingudSlot(withoutAbortSignal(options), launchedDir, true).catch(
    (error: unknown) => `unverifiable: ${errorMessage(error)}`
  )
  if (stopped !== 'stopped' && stopped !== 'already-exited') {
    lock.retain()
    return (
      `kingud ${input.launchedVersion} could not be confirmed stopped (${stopped}), so nothing ` +
      'was restored over state it may still own. This host requires recovery.'
    )
  }
  const failure = await putTransactionIncumbentBack(options, lock, restore)
  return (
    failure ??
    (input.incumbent
      ? `kingud ${input.incumbent.version} was restarted and is serving again.`
      : 'No previous version was active, so this host is now serving nothing.')
  )
}
