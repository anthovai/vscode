/**
 * Finishing or undoing an activation, rollback or decommission that a crash, a lost connection or an
 * unverifiable failure left fenced. Either way the host ends serving exactly the slot its
 * activation record names, or the fence stays for an operator.
 */
import type { ServeReadiness } from '../server/serve-readiness'
import {
  planKingudTransactionRecovery,
  type KingudActivationTransaction
} from './kingud-activation-transaction'
import { readKingudActivationTransaction } from './kingud-activation-transaction-store'
import {
  readKingudActivationRecord,
  writeKingudActivationRecord
} from './kingud-activation-record-store'
import {
  kingudActivationFenceExists,
  withStaleKingudActivationRecoveryLock
} from './kingud-activation-lock'
import { RemoteInstallLockBusyError } from './ssh-relay-install-lock'
import { ensureKingudSlotServing, resolveKingudSlotIdentity } from './kingud-recovery-slot'
import { reconcileKingudDecommission } from './kingud-decommission-recovery'
import {
  recoverKingudIncumbent,
  type KingudIncumbentRecoveryOptions
} from './kingud-incumbent-recovery'
import type { KingudManagedRefusal } from '../../shared/kingud-managed-runtime'
import { resumeInterruptedKingudCandidate } from './kingud-interrupted-candidate-resume'
import { errorMessage } from '../../shared/error-message'

export type KingudActivationRecoveryResult =
  | { outcome: 'none' }
  | { outcome: 'pending'; code: string; reason: string }
  | {
      outcome: 'recovered'
      resolution: 'committed' | 'restored-incumbent'
      activeVersion: string | null
      readiness: ServeReadiness | null
    }
  | KingudManagedRefusal

export type KingudActivationRecoveryOptions = KingudIncumbentRecoveryOptions

export const KINGUD_RECOVERY_UNVERIFIABLE_CODE = 'kingud_recovery_unverifiable'

export async function recoverInterruptedKingudActivation(
  options: KingudActivationRecoveryOptions
): Promise<KingudActivationRecoveryResult> {
  try {
    if (
      !(await readKingudActivationTransaction(options)) &&
      !(await kingudActivationFenceExists(options))
    ) {
      return { outcome: 'none' }
    }
    return await withStaleKingudActivationRecoveryLock(options, async (lock) => {
      const transaction = await readKingudActivationTransaction(options)
      if (!transaction) {
        // A release cut short after removing the journal; dropping the lock finishes it.
        return { outcome: 'none' }
      }
      const result = await reconcileKingudTransaction(options, transaction)
      if (result.outcome !== 'recovered') {
        lock.retain()
      }
      return result
    })
  } catch (error) {
    if (error instanceof RemoteInstallLockBusyError) {
      return {
        outcome: 'pending',
        code: 'kingud_recovery_transaction_still_fresh',
        reason:
          'The activation fence is held by a run that may still be working. Retry after the ' +
          'install lock recovery window.'
      }
    }
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: KINGUD_RECOVERY_UNVERIFIABLE_CODE,
      reason:
        `The interrupted activation could not be reconciled safely: ${errorMessage(error)} ` +
        'The host remains fenced.'
    }
  }
}

/** Runs under a held fence. Throws when a step is unverifiable. */
export async function reconcileKingudTransaction(
  options: KingudActivationRecoveryOptions,
  transaction: KingudActivationTransaction
): Promise<KingudActivationRecoveryResult> {
  const plan = planKingudTransactionRecovery(transaction, await readKingudActivationRecord(options))
  if (plan.action === 'refuse') {
    return { outcome: 'refused', verdict: 'unverifiable', code: plan.code, reason: plan.reason }
  }
  if (
    plan.action === 'confirm-decommissioned' ||
    plan.action === 'resume-stop' ||
    plan.action === 'keep-serving'
  ) {
    return reconcileKingudDecommission(options, plan)
  }
  if (plan.action === 'finish-commit') {
    await writeKingudActivationRecord(options, plan.record)
  }
  if (plan.action === 'stabilize-committed' || plan.action === 'finish-commit') {
    const activeVersion = plan.action === 'finish-commit' ? plan.record.active : plan.activeVersion
    if (!activeVersion) {
      throw new Error('The committed activation record has no active version.')
    }
    const identity = await resolveKingudSlotIdentity(options, activeVersion)
    return {
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion,
      readiness: await ensureKingudSlotServing(options, identity)
    }
  }
  if (transaction.operation === 'activate' && plan.launchedVersion) {
    const readiness = await resumeInterruptedKingudCandidate(options, transaction)
    if (readiness && 'outcome' in readiness) {
      return readiness
    }
    if (readiness) {
      return {
        outcome: 'recovered',
        resolution: 'committed',
        activeVersion: transaction.candidateVersion,
        readiness
      }
    }
  }
  const recovery = await recoverKingudIncumbent(options, {
    transactionStartedAt: transaction.startedAt,
    launchedVersion: plan.launchedVersion,
    incumbent: plan.activeVersion
      ? await resolveKingudSlotIdentity(options, plan.activeVersion)
      : null,
    restoreState: plan.restoreState,
    launchedFromState: plan.launchedFromState
  })
  return recovery.outcome === 'refused'
    ? recovery
    : {
        outcome: 'recovered',
        resolution: 'restored-incumbent',
        activeVersion: plan.activeVersion,
        readiness: recovery.readiness
      }
}
