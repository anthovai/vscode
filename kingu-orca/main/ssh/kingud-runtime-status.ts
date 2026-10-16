import type { KingudManagedRuntimeStatus } from '../../shared/kingud-managed-runtime'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import type { KingudActivationTransaction } from './kingud-activation-transaction'
import { readKingudActivationTransaction } from './kingud-activation-transaction-store'
import {
  requireManagedKingudEnvironment,
  resolveLinkedKingudContext
} from './kingud-managed-runtime-context'
import { currentManagedKingudUpdateDeferral } from './kingud-managed-update-deferrals'
import { findIncompleteManagedKingudMigration } from './kingud-managed-migration-status'
import { collectManagedTerminalCensus } from './kingud-terminal-census-client'

/** Read-only: what the host's activation record and journal say, without repairing either. */
export async function getManagedKingudRuntimeStatus(
  userDataPath: string,
  selector: string,
  signal?: AbortSignal
): Promise<KingudManagedRuntimeStatus> {
  const { environment, deployment } = requireManagedKingudEnvironment(userDataPath, selector)
  return runTargetLifecycle(deployment.sshTargetId, async () => {
    const context = await resolveLinkedKingudContext(environment, deployment, signal)
    const record = context.activationRecord
    const transaction = await readKingudActivationTransaction({
      conn: context.connection,
      host: context.host,
      remoteHome: context.remoteHome,
      signal
    })
    return {
      environmentId: environment.id,
      sshTargetId: context.target.id,
      activeVersion: record.active,
      previousVersion: record.previous,
      activatedAt: record.activatedAt,
      rollbackAvailable: Boolean(record.previous && record.snapshot),
      recovery: transaction ? managedRecoveryStatus(transaction) : null,
      terminals: await collectManagedTerminalCensus(userDataPath, environment, record),
      migration: migrationStatus(userDataPath, environment.id),
      deferredUpdate: currentManagedKingudUpdateDeferral(environment.id, record.active)
    }
  })
}

function managedRecoveryStatus(
  transaction: KingudActivationTransaction
): NonNullable<KingudManagedRuntimeStatus['recovery']> {
  switch (transaction.operation) {
    case 'activate':
      return {
        operation: transaction.operation,
        phase: transaction.phase,
        version: transaction.candidateVersion,
        startedAt: transaction.startedAt
      }
    case 'rollback':
      return {
        operation: transaction.operation,
        phase: transaction.phase,
        version: transaction.targetVersion,
        startedAt: transaction.startedAt
      }
    case 'decommission':
      return {
        operation: transaction.operation,
        phase: transaction.phase,
        version: transaction.activeVersion,
        startedAt: transaction.startedAt
      }
  }
}

function migrationStatus(
  userDataPath: string,
  environmentId: string
): KingudManagedRuntimeStatus['migration'] {
  const migration = findIncompleteManagedKingudMigration(userDataPath, environmentId)
  return migration
    ? { migrationId: migration.migrationId, phase: migration.phase, startedAt: migration.startedAt }
    : null
}
