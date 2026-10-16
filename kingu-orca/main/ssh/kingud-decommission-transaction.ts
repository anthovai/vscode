/**
 * The decommission entry of the activation journal: stop the active kingud with an
 * instance-bound request and record that nothing serves, or put it back.
 *
 * Phases: `prepared` (nothing sent), `stop-dispatched` (the request may have reached the
 * host), `process-exited` (exit proven by a completed-stop receipt). Only the last may commit.
 * On the host the later two are filed under `dispatched`; see `kingudDecommissionJournal`.
 */
import {
  serializeKingudActivationRecord,
  withDeactivatedVersion,
  withDeactivatedVersionCommitted,
  type KingudActivationRecord
} from './kingud-activation-record'
import { KINGUD_ACTIVATION_TRANSACTION_SCHEMA_VERSION } from './kingud-activation-transaction-schema'
import type { KingudManagedStopRequest } from '../../shared/kingud-stop-request'

export type KingudDecommissionTransaction = {
  schemaVersion: typeof KINGUD_ACTIVATION_TRANSACTION_SCHEMA_VERSION
  transactionId: string
  operation: 'decommission'
  phase: 'prepared' | 'stop-dispatched' | 'process-exited'
  startedAt: string
  updatedAt: string
  activeVersion: string
  recordBefore: KingudActivationRecord
  recordAfter: KingudActivationRecord
  request: KingudManagedStopRequest | null
}

/** A dispatched stop as journaled: the real phase, under a field released desktops drop. */
export type KingudDecommissionDispatch = {
  phase: 'stop-dispatched' | 'process-exited'
  request: KingudManagedStopRequest
}

export type KingudDecommissionJournal = Omit<KingudDecommissionTransaction, 'phase' | 'request'> & {
  phase: 'prepared'
  request: null
  dispatched?: KingudDecommissionDispatch
}

export type KingudDecommissionRecoveryPlan =
  /** Exit was proven; write the deactivated record (if it is not there yet) and confirm. */
  | { action: 'confirm-decommissioned'; version: string; record: KingudActivationRecord | null }
  /** The request may have reached kingud; its completion or cancellation decides. */
  | { action: 'resume-stop'; request: KingudManagedStopRequest; record: KingudActivationRecord }
  /** Nothing was sent; the active version must still be serving. */
  | { action: 'keep-serving'; version: string }

export function createKingudDecommissionTransaction(options: {
  transactionId: string
  recordBefore: KingudActivationRecord & { active: string }
  now: Date
}): KingudDecommissionTransaction {
  const timestamp = options.now.toISOString()
  return {
    schemaVersion: KINGUD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
    transactionId: options.transactionId,
    operation: 'decommission',
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    activeVersion: options.recordBefore.active,
    recordBefore: options.recordBefore,
    recordAfter: withDeactivatedVersion(options.recordBefore),
    request: null
  }
}

export function withKingudDecommissionStopDispatched(
  transaction: KingudDecommissionTransaction,
  request: KingudManagedStopRequest,
  now: Date
): KingudDecommissionTransaction {
  return { ...transaction, phase: 'stop-dispatched', updatedAt: now.toISOString(), request }
}

export function withKingudDecommissionProcessExited(
  transaction: KingudDecommissionTransaction,
  now: Date
): KingudDecommissionTransaction {
  return { ...transaction, phase: 'process-exited', updatedAt: now.toISOString() }
}

/**
 * The entry as written to the host. Why a dispatched stop still reads `prepared` at the top level:
 * a released desktop recovering `stop-dispatched` or `process-exited` commits its core recordAfter,
 * which drops the stopped build's activeAppVersion, and its next connect then deploys its own older
 * build over state the stopped one may have migrated. Reading `prepared`, it relaunches the recorded
 * build instead. Released readers drop the unknown `dispatched` field.
 */
export function kingudDecommissionJournal(
  transaction: KingudDecommissionTransaction
): KingudDecommissionJournal {
  const { phase, request, ...rest } = transaction
  return phase === 'prepared' || !request
    ? { ...rest, phase: 'prepared', request: null }
    : { ...rest, phase: 'prepared', request: null, dispatched: { phase, request } }
}

/** A reason when the parsed journal is not a coherent decommission; otherwise `null`. */
export function kingudDecommissionTransactionDefect(
  transaction: KingudDecommissionTransaction
): string | null {
  if (transaction.recordBefore.active !== transaction.activeVersion) {
    return 'decommission version does not match recordBefore'
  }
  if (
    serializeKingudActivationRecord(transaction.recordAfter) !==
    serializeKingudActivationRecord(withDeactivatedVersion(transaction.recordBefore))
  ) {
    return 'recordAfter is not the deactivated recordBefore'
  }
  if (transaction.request && transaction.request.version !== transaction.activeVersion) {
    return 'stop request names another version'
  }
  return null
}

/** Called once the current record matched one side of the transaction. */
export function planKingudDecommissionRecovery(
  transaction: KingudDecommissionTransaction,
  committed: boolean
): KingudDecommissionRecoveryPlan {
  if (committed) {
    return { action: 'confirm-decommissioned', version: transaction.activeVersion, record: null }
  }
  if (transaction.phase === 'process-exited') {
    return {
      action: 'confirm-decommissioned',
      version: transaction.activeVersion,
      record: committedKingudDecommissionRecord(transaction)
    }
  }
  if (transaction.phase === 'stop-dispatched' && transaction.request) {
    return {
      action: 'resume-stop',
      request: transaction.request,
      record: committedKingudDecommissionRecord(transaction)
    }
  }
  return { action: 'keep-serving', version: transaction.activeVersion }
}

/** The record a finished stop writes: the journaled `recordAfter` plus its advisory fields. */
export function committedKingudDecommissionRecord(
  transaction: KingudDecommissionTransaction
): KingudActivationRecord {
  return withDeactivatedVersionCommitted(transaction.recordBefore)
}
