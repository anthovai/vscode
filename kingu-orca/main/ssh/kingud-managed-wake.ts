/**
 * Starting a managed kingud that is installed and activated but not running, most often one
 * that stopped itself after idling. A stopped server is just "not running": it is neither a
 * failure nor evidence about terminals, which the daemon owns and which outlive kingud.
 */
import { KINGUD_FENCE_OWNER_FILENAME } from './kingud-activation-fence-scope'
import type { ServeReadiness } from '../server/serve-readiness'
import { readKingudActivationRecord } from './kingud-activation-record-store'
import { randomUUID } from 'node:crypto'
import {
  kingudActivationFenceExists,
  releaseKingudActivationFence,
  withKingudActivationLock
} from './kingud-activation-lock'
import { readBoundedKingudRemoteRecord } from './kingud-remote-record-file'
import { kingudActivationFenceLockDir } from './kingud-activation-transaction'
import { joinRemotePath } from './ssh-remote-platform'

import { readKingudActivationTransaction } from './kingud-activation-transaction-store'
import {
  KINGUD_RECOVERY_UNVERIFIABLE_CODE,
  recoverInterruptedKingudActivation
} from './kingud-activation-recovery'
import {
  ensureKingudSlotServing,
  kingudSlotDir,
  resolveKingudSlotIdentity,
  slotLiveness,
  type KingudSlotOptions
} from './kingud-recovery-slot'

export type KingudManagedWake =
  | { outcome: 'serving' | 'not-activated' | 'unverifiable' }
  /** An update, rollback or recovery holds the host; it owns which slot serves. */
  | { outcome: 'fenced' }
  | { outcome: 'started'; readiness: ServeReadiness }
  /** An abandoned update or rollback that recovery could not finish without an operator. */
  | { outcome: 'recovery-refused'; reason: string }

/** Launches the active slot only on proven exit; a live or unprovable process is left alone. */
export function wakeStoppedManagedKingud(
  options: KingudSlotOptions,
  onStarting: () => void = () => {}
): Promise<KingudManagedWake> {
  const host = wakeHostKey(options)
  // Registered before any remote step: a wake on a dropped connection settles first, so a
  // reconnected wake never races it to the fence and finds its fence unexplained.
  const prior = runningWakes.get(host)
  const wake = (async (): Promise<KingudManagedWake> => {
    await prior?.catch(() => {})
    return wakeAfterPrior(options, host, onStarting)
  })()
  runningWakes.set(host, wake)
  void wake
    .catch(() => {})
    .finally(() => {
      if (runningWakes.get(host) === wake) {
        runningWakes.delete(host)
      }
    })
  return wake
}

async function wakeAfterPrior(
  options: KingudSlotOptions,
  host: string,
  onStarting: () => void
): Promise<KingudManagedWake> {
  const before = await readKingudActivationRecord(options)
  if (!before.active) {
    return { outcome: 'not-activated' }
  }
  const liveness = await slotLiveness(options, kingudSlotDir(options, before.active))
  if (liveness !== 'DEAD') {
    return { outcome: liveness === 'LIVE' ? 'serving' : 'unverifiable' }
  }
  if (!(await kingudActivationFenceExists(options))) {
    // The fence this client left is gone by some other route; any later one belongs to another run.
    interruptedWakes.delete(host)
  } else if (!(await releaseOwnInterruptedWakeFence(options, host))) {
    const recovered = await recoverAbandonedFence(options, onStarting)
    if (recovered) {
      return recovered
    }
  }
  // Claimed before the fence and written by the command that creates it: a drop at any point
  // after the fence lands leaves one this client can prove its own. Kept on any failure, since a
  // release over a dropped connection fails quietly; the next wake re-proves it on the host.
  const token = randomUUID()
  interruptedWakes.set(host, token)
  const result = await withKingudActivationLock(
    options,
    async (): Promise<KingudManagedWake> => {
      // Re-read under the fence: another client may have activated or started a slot meanwhile.
      const active = (await readKingudActivationRecord(options)).active
      if (!active) {
        return { outcome: 'not-activated' }
      }
      const identity = await resolveKingudSlotIdentity(options, active)
      onStarting()
      return { outcome: 'started', readiness: await ensureKingudSlotServing(options, identity) }
    },
    (): KingudManagedWake => ({ outcome: 'fenced' }),
    token
  )
  // Released, or never acquired.
  if (interruptedWakes.get(host) === token) {
    interruptedWakes.delete(host)
  }
  return result
}

/**
 * An update or rollback whose client quit or crashed leaves a journal nobody finishes, so a later
 * reboot would serve nothing until a manual Recover (P1-A). Recovery takes only a stale,
 * previous-boot or exited-own fence; a run still working answers busy. Null: the fence is gone.
 */
async function recoverAbandonedFence(
  options: KingudSlotOptions,
  onStarting: () => void
): Promise<KingudManagedWake | null> {
  const recovery = await recoverInterruptedKingudActivation(options)
  switch (recovery.outcome) {
    case 'none':
      return null
    case 'pending':
      return { outcome: 'fenced' }
    case 'refused':
      // A step the host did not answer is retried on the fence recheck, like a busy fence.
      return recovery.code === KINGUD_RECOVERY_UNVERIFIABLE_CODE
        ? { outcome: 'fenced' }
        : { outcome: 'recovery-refused', reason: recovery.reason }
    case 'recovered':
      if (!recovery.readiness) {
        return { outcome: 'not-activated' }
      }
      onStarting()
      return { outcome: 'started', readiness: recovery.readiness }
  }
}

const runningWakes = new Map<string, Promise<KingudManagedWake>>()

// The owner token of a fence this client's own wake may have left when its connection dropped.
const interruptedWakes = new Map<string, string>()

function wakeOwnerPath(options: KingudSlotOptions): string {
  return joinRemotePath(
    options.host,
    kingudActivationFenceLockDir(options.host, options.remoteHome),
    KINGUD_FENCE_OWNER_FILENAME
  )
}

function wakeHostKey(options: KingudSlotOptions): string {
  return `${options.conn.getTarget().id}\0${options.remoteHome}`
}

/**
 * Releases only the fence carrying this client's own interrupted wake token and no journal; the
 * slot was just proven exited and kingud's instance lock bars a double start.
 */
async function releaseOwnInterruptedWakeFence(
  options: KingudSlotOptions,
  host: string
): Promise<boolean> {
  const token = interruptedWakes.get(host)
  if (!token || (await readKingudActivationTransaction(options))) {
    return false
  }
  // Only a fence carrying this process's own token: a fresh fence another client took has none yet.
  const owner = await readBoundedKingudRemoteRecord(options, wakeOwnerPath(options), 64)
  if (owner.state !== 'present' || owner.raw.trim() !== token) {
    interruptedWakes.delete(host)
    return false
  }
  await releaseKingudActivationFence(options, token)
  interruptedWakes.delete(host)
  return true
}
