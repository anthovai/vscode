/**
 * Decommissioning a managed kingud: stop its active instance and record that nothing serves.
 *
 * Runs under the activation fence and journal, so an interrupted decommission recovers like an
 * activation does. It refuses while the terminal census says terminals are live or cannot be
 * counted, and it never signals: the instance-bound request reaches only the kingud it names.
 * Only proven exit deactivates the record; anything less withdraws the request or keeps the
 * fence. Windows runs the same steps: the request is a staged file and exit proof is kingud's own.
 */
import { randomUUID } from 'node:crypto'
import type { KingudActivationRecord } from './kingud-activation-record'
import {
  readKingudActivationRecord,
  writeKingudActivationRecord
} from './kingud-activation-record-store'
import { sameKingudActivationRecord } from './kingud-activation-transaction'
import { writeKingudActivationTransaction } from './kingud-activation-transaction-store'
import { withKingudActivationLock } from './kingud-activation-lock'
import { kingudActivationFenceRefusal } from './kingud-activation-fence-hold'
import {
  committedKingudDecommissionRecord,
  createKingudDecommissionTransaction,
  withKingudDecommissionProcessExited,
  withKingudDecommissionStopDispatched
} from './kingud-decommission-transaction'
import { readRemoteKingudManagedStopTarget } from './kingud-managed-remote-stop'
import { settleKingudDecommissionStop } from './kingud-decommission-stop'
import type { KingudSlotOptions } from './kingud-recovery-slot'
import type { KingudDecommissionResult } from '../../shared/kingud-decommission'
import type { KingudTerminalCensus } from '../../shared/kingud-terminal-census'

export type KingudDecommissionOptions = KingudSlotOptions & {
  /** The record the caller reviewed; a changed host record refuses rather than guessing. */
  record: KingudActivationRecord
  /** Taken by the caller just before; any live or uncounted terminal refuses. */
  census: KingudTerminalCensus
  now?: () => Date
}

type Refusal = Extract<KingudDecommissionResult, { outcome: 'refused' }>

function refuse(verdict: Refusal['verdict'], code: string, reason: string): Refusal {
  return { outcome: 'refused', verdict, code, reason }
}

function censusRefusal(census: KingudTerminalCensus): Refusal | null {
  if (census.liveSessions === null) {
    return refuse(
      'unverifiable',
      'kingud_decommission_census_unavailable',
      'The terminal daemon did not answer a session count, so decommissioning could end ' +
        'running work. Retry when the host answers.'
    )
  }
  if (census.liveSessions > 0) {
    return refuse(
      'live',
      'kingud_decommission_terminals_running',
      `${census.liveSessions} terminal${census.liveSessions === 1 ? ' is' : 's are'} still ` +
        'running on this host. Close them before decommissioning the server.'
    )
  }
  return null
}

export async function decommissionRemoteKingud(
  options: KingudDecommissionOptions
): Promise<KingudDecommissionResult> {
  const now = options.now ?? ((): Date => new Date())
  return withKingudActivationLock(
    options,
    async (lock) => {
      const record = await readKingudActivationRecord(options)
      if (!sameKingudActivationRecord(record, options.record)) {
        return refuse(
          'unverifiable',
          'kingud_decommission_record_changed',
          'The host activation record changed since it was reviewed. Refresh and try again.'
        )
      }
      const activeVersion = record.active
      if (!activeVersion) {
        return refuse(
          'unverifiable',
          'kingud_decommission_nothing_active',
          'No kingud version is active on this host, so there is nothing to decommission.'
        )
      }
      const census = censusRefusal(options.census)
      if (census) {
        return census
      }
      const target = await readRemoteKingudManagedStopTarget(options, activeVersion)
      if (target.state === 'refused') {
        return refuse(target.verdict, target.code, target.reason)
      }

      let transaction = createKingudDecommissionTransaction({
        transactionId: randomUUID(),
        recordBefore: { ...record, active: activeVersion },
        now: now()
      })
      await writeKingudActivationTransaction(options, transaction)
      lock.retainOnError()
      const request = {
        schemaVersion: 1 as const,
        transactionId: transaction.transactionId,
        ...target.context,
        // Best effort: an idle daemon goes with kingud, a busy one keeps its terminals.
        retireIdleDaemon: true as const
      }
      // Durable before it can reach the host, so recovery can settle exactly this request.
      transaction = withKingudDecommissionStopDispatched(transaction, request, now())
      await writeKingudActivationTransaction(options, transaction)

      const settlement = await settleKingudDecommissionStop(options, request)
      if (settlement.state === 'withdrawn') {
        // kingud never acted on it and keeps serving; the record never changed.
        return refuse(settlement.verdict, 'kingud_decommission_stop_withdrawn', settlement.reason)
      }
      if (settlement.state === 'unsettled') {
        lock.retain()
        return refuse(settlement.verdict, 'kingud_decommission_stop_unsettled', settlement.reason)
      }
      transaction = withKingudDecommissionProcessExited(transaction, now())
      await writeKingudActivationTransaction(options, transaction)
      await writeKingudActivationRecord(options, committedKingudDecommissionRecord(transaction))
      return {
        outcome: 'decommissioned',
        version: activeVersion,
        retirement: settlement.retirement
      }
    },
    async () => {
      const refusal = await kingudActivationFenceRefusal(options, 'stop')
      return refuse('unverifiable', refusal.code, refusal.reason)
    }
  )
}
