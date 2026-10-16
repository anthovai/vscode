import type { KingudActivationRecord } from './kingud-activation-record'
import { KINGUD_ACTIVATION_TRANSACTION_SCHEMA_VERSION } from './kingud-activation-transaction-schema'
import type {
  KingudActivateTransaction,
  KingudRollbackTransaction
} from './kingud-activation-transaction'

export function createKingudActivationTransaction(options: {
  transactionId: string
  candidateVersion: string
  appVersion?: string
  recordBefore: KingudActivationRecord
  snapshotDirName: string
  now: Date
}): KingudActivateTransaction {
  const timestamp = options.now.toISOString()
  return {
    schemaVersion: KINGUD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
    transactionId: options.transactionId,
    operation: 'activate',
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    candidateVersion: options.candidateVersion,
    candidateAppVersion: options.appVersion ?? null,
    recordBefore: options.recordBefore,
    recordAfter: null,
    snapshot: { dirName: options.snapshotDirName, state: 'pending' }
  }
}

export function withKingudActivationIncumbentStopped(
  transaction: KingudActivateTransaction,
  now: Date
): KingudActivateTransaction {
  return {
    ...transaction,
    phase: 'incumbent-stopped',
    updatedAt: now.toISOString()
  }
}

export function withKingudActivationSnapshot(
  transaction: KingudActivateTransaction,
  state: 'captured' | 'empty',
  now: Date
): KingudActivateTransaction {
  return {
    ...transaction,
    phase: 'snapshot-captured',
    updatedAt: now.toISOString(),
    snapshot: { dirName: transaction.snapshot.dirName, state }
  }
}

export function withKingudActivationCandidateReady(
  transaction: KingudActivateTransaction,
  recordAfter: KingudActivationRecord,
  now: Date
): KingudActivateTransaction {
  return {
    ...transaction,
    phase: 'candidate-ready',
    updatedAt: now.toISOString(),
    recordAfter
  }
}

export function createKingudRollbackTransaction(options: {
  transactionId: string
  incumbentVersion: string
  targetVersion: string
  recordBefore: KingudActivationRecord
  recordAfter: KingudActivationRecord
  rescueDirName: string
  now: Date
}): KingudRollbackTransaction {
  const timestamp = options.now.toISOString()
  return {
    schemaVersion: KINGUD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
    transactionId: options.transactionId,
    operation: 'rollback',
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    incumbentVersion: options.incumbentVersion,
    targetVersion: options.targetVersion,
    recordBefore: options.recordBefore,
    recordAfter: options.recordAfter,
    rescue: { dirName: options.rescueDirName, state: 'pending' }
  }
}

export function withKingudRollbackPhase(
  transaction: KingudRollbackTransaction,
  phase: 'incumbent-stopped' | 'rollback-state-restored' | 'target-ready',
  now: Date
): KingudRollbackTransaction {
  return { ...transaction, phase, updatedAt: now.toISOString() }
}

export function withKingudRollbackRescue(
  transaction: KingudRollbackTransaction,
  state: 'captured' | 'empty',
  now: Date
): KingudRollbackTransaction {
  return {
    ...transaction,
    phase: 'rescue-captured',
    updatedAt: now.toISOString(),
    rescue: { dirName: transaction.rescue.dirName, state }
  }
}
