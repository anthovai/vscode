/**
 * What an in-flight activation, rollback or decommission still needs from GC.
 *
 * The journal names every slot the transaction may restart or settle; GC must keep them all.
 * A held fence without a journal, or a journal this client cannot read, means a transaction
 * this client cannot see into, so GC keeps everything rather than guess.
 */
import { kingudInstallDirNames } from './kingud-activation-record'
import type { KingudActivationTransaction } from './kingud-activation-transaction'
import { readKingudActivationTransaction } from './kingud-activation-transaction-store'
import { kingudActivationFenceExists } from './kingud-activation-lock'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import type { KingudRemoteExecTarget } from './kingud-remote-runtime-control'

export type KingudGcTransactionPins =
  | { state: 'pinned'; dirNames: string[] }
  | { state: 'keep-all' }

function transactionVersions(transaction: KingudActivationTransaction): (string | null)[] {
  const records = [transaction.recordBefore, transaction.recordAfter]
  const fromRecords = records.flatMap((record) => (record ? [record.active, record.previous] : []))
  if (transaction.operation === 'activate') {
    return [...fromRecords, transaction.candidateVersion]
  }
  // Any other operation names its slots through its records.
  return transaction.operation === 'rollback'
    ? [...fromRecords, transaction.incumbentVersion, transaction.targetVersion]
    : fromRecords
}

export async function readKingudGcTransactionPins(
  target: KingudRemoteExecTarget & { remoteHome: string }
): Promise<KingudGcTransactionPins> {
  try {
    const transaction = await readKingudActivationTransaction(target)
    if (!transaction) {
      // A fence without a journal is a transaction starting or a release cut short.
      return (await kingudActivationFenceExists(target))
        ? { state: 'keep-all' }
        : { state: 'pinned', dirNames: [] }
    }
    return { state: 'pinned', dirNames: kingudInstallDirNames(transactionVersions(transaction)) }
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return { state: 'keep-all' }
  }
}
