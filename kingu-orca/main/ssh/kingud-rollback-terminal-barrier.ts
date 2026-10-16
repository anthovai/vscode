/**
 * The rollback's terminal barrier. The census a rollback plans on is taken while kingud still
 * admits work, so it cannot vouch for the moment the older snapshot replaces the state. The
 * incumbent is stopped through its managed stop with idle-daemon retirement instead: kingud closes
 * terminal admission on every daemon generation, counts live sessions under that fence, and
 * retires the daemon only when none exist. Only `retired` proves no terminal ran then or could
 * start after; anything else keeps the incumbent's state and puts it back.
 */
import {
  readRemoteKingudManagedStopTarget,
  type KingudManagedStopTarget
} from './kingud-managed-remote-stop'
import { settleKingudDecommissionStop } from './kingud-decommission-stop'
import type { KingudSlotOptions } from './kingud-recovery-slot'
import type { KingudManagedStopContext } from '../../shared/kingud-stop-request'

export type KingudRollbackBarrier =
  | { state: 'retired' }
  /** kingud withdrew the stop and keeps serving: nothing changed. */
  | { state: 'withdrawn'; reason: string }
  /** kingud may still be stopping, or the host could not say: the fence must stay. */
  | { state: 'unsettled'; reason: string }
  /** kingud exited, but live or unproven work remains: the incumbent must be restarted. */
  | { state: 'unproven'; reason: string }

/** Names the incumbent instance before any mutation; a build without managed stop is refused. */
export async function readKingudRollbackBarrierTarget(
  options: KingudSlotOptions,
  version: string
): Promise<KingudManagedStopTarget> {
  const target = await readRemoteKingudManagedStopTarget(options, version)
  return target.state === 'ready'
    ? target
    : {
        ...target,
        code: 'kingud_rollback_terminal_barrier_unavailable',
        reason:
          `${target.reason} A rollback needs kingud to prove no terminal runs at its stop; ` +
          'nothing was changed.'
      }
}

export async function stopIncumbentBehindTerminalBarrier(
  options: KingudSlotOptions,
  transactionId: string,
  context: KingudManagedStopContext
): Promise<KingudRollbackBarrier> {
  const settlement = await settleKingudDecommissionStop(options, {
    schemaVersion: 1,
    transactionId,
    ...context,
    retireIdleDaemon: true
  })
  if (settlement.state === 'withdrawn' || settlement.state === 'unsettled') {
    return { state: settlement.state, reason: settlement.reason }
  }
  if (settlement.retirement === 'retired') {
    return { state: 'retired' }
  }
  return {
    state: 'unproven',
    reason:
      `kingud ${context.version} stopped, but its terminal daemon reported ` +
      `${settlement.retirement} work at the stop, so the older snapshot was not restored.`
  }
}

export type KingudRollbackBarrierRefusal = {
  outcome: 'refused' | 'failed'
  code: string
  reason: string
  /** kingud may still be stopping, so the fence stays. */
  retainFence: boolean
  /** kingud exited without proving it ran no terminal, so its own state goes back up. */
  restartIncumbent: boolean
}

/** Null only for a retired daemon, the one answer that lets the older snapshot replace state. */
export function rollbackBarrierRefusal(
  barrier: KingudRollbackBarrier
): KingudRollbackBarrierRefusal | null {
  switch (barrier.state) {
    case 'retired':
      return null
    case 'withdrawn':
      return {
        outcome: 'failed',
        code: 'kingud_rollback_stop_withdrawn',
        reason: barrier.reason,
        retainFence: false,
        restartIncumbent: false
      }
    case 'unsettled':
      return {
        outcome: 'failed',
        code: 'kingud_rollback_stop_incomplete',
        reason: `${barrier.reason} Nothing was restored.`,
        retainFence: true,
        restartIncumbent: false
      }
    case 'unproven':
      return {
        outcome: 'refused',
        code: 'kingud_rollback_terminals_at_stop',
        reason: barrier.reason,
        retainFence: false,
        restartIncumbent: true
      }
  }
}
