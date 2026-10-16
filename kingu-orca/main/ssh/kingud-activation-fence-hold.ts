/**
 * Why a fence answered "held": a run that is still working clears on its own and is retried on
 * a later connect. A stale fence with no journal is cleared here, since Recover would only drop it.
 * Only a stale lock over a journal, or a journal no fence guards, needs Recover: a live run
 * journals under a fresh fence too, and Recover cannot take a fresh fence anyway.
 */
import {
  kingudActivationFenceExists,
  withStaleKingudActivationRecoveryLock,
  type KingudActivationLockOptions
} from './kingud-activation-lock'
import { readKingudActivationTransaction } from './kingud-activation-transaction-store'
import { kingudActivationFenceLockDir } from './kingud-activation-transaction'
import { isRelayInstallLockStale } from './ssh-relay-install-lock'
import { findExitedOwnLockToken } from './kingud-exited-own-lock'
import { kingudRemoteBaseDir } from './kingud-remote-windows-node'

export const KINGUD_ACTIVATION_FENCE_BUSY_CODE = 'kingud_activation_fence_busy'
const KINGUD_ACTIVATION_RECOVERY_REQUIRED_CODE = 'kingud_activation_recovery_required'

type KingudActivationFenceRefusal = {
  code: string
  reason: string
  /** A stale fence no journal backed was cleared, so the attempt may run again at once. */
  cleared?: true
}

export async function kingudActivationFenceRefusal(
  options: KingudActivationLockOptions,
  attempt: string
): Promise<KingudActivationFenceRefusal> {
  const lockDir = kingudActivationFenceLockDir(options.host, options.remoteHome)
  // An unreadable answer reads as busy: retrying later is never wrong, a sticky failure can be.
  const journal = (await readKingudActivationTransaction(options).catch(() => null)) !== null
  const baseDir = kingudRemoteBaseDir(options.host, options.remoteHome)
  const stale =
    (await findExitedOwnLockToken(options, lockDir, { baseDir, guardsStateMutation: true })) !==
      null || (await isRelayInstallLockStale(options.conn, lockDir, options.host))
  if (stale && !journal && (await clearAbandonedFence(options))) {
    // A wake or release cut short leaves a bare fence; Recover would only drop it (BUG-21).
    return {
      code: KINGUD_ACTIVATION_FENCE_BUSY_CODE,
      reason: `An abandoned fence held this host and was cleared; the ${attempt} is retried.`,
      cleared: true
    }
  }
  const stuck =
    stale || (journal && !(await kingudActivationFenceExists(options).catch(() => true)))
  return stuck
    ? {
        code: KINGUD_ACTIVATION_RECOVERY_REQUIRED_CODE,
        reason: `An interrupted update or stop holds this host, so the ${attempt} did not start. Recover it first.`
      }
    : {
        code: KINGUD_ACTIVATION_FENCE_BUSY_CODE,
        reason: `Another run is changing this host's managed server, so the ${attempt} did not start. It is retried on a later connect.`
      }
}

/** Takes the stale fence over and drops it, unless a journal appeared under it meanwhile. */
async function clearAbandonedFence(options: KingudActivationLockOptions): Promise<boolean> {
  try {
    return await withStaleKingudActivationRecoveryLock(options, async (lock) => {
      if (await readKingudActivationTransaction(options)) {
        lock.retain()
        return false
      }
      return true
    })
  } catch {
    // Another client took it first, or the host did not answer: classify as before.
    return false
  }
}
