import {
  kingudActivationTransactionPath,
  parseKingudActivationTransaction,
  serializeKingudActivationTransaction,
  type KingudActivationTransaction
} from './kingud-activation-transaction'
import {
  readBoundedKingudRemoteRecord,
  writeAtomicKingudRemoteRecord
} from './kingud-remote-record-file'
import type { KingudRemoteExecTarget } from './kingud-remote-runtime-control'
import { currentKingudFence } from './kingud-activation-fence-scope'

const KINGUD_ACTIVATION_TRANSACTION_MAX_BYTES = 64 * 1024

type KingudActivationTransactionStoreOptions = KingudRemoteExecTarget & { remoteHome: string }

/** `null` only on a verified absence; an unreadable journal keeps the host fenced. */
export async function readKingudActivationTransaction(
  options: KingudActivationTransactionStoreOptions
): Promise<KingudActivationTransaction | null> {
  const read = await readBoundedKingudRemoteRecord(
    options,
    kingudActivationTransactionPath(options.host, options.remoteHome),
    KINGUD_ACTIVATION_TRANSACTION_MAX_BYTES
  )
  const parsed = parseKingudActivationTransaction(read.state === 'present' ? read.raw : null)
  if (parsed.state === 'unreadable') {
    throw new Error(`Cannot read this host's kingud activation transaction: ${parsed.reason}`)
  }
  return parsed.state === 'ok' ? parsed.transaction : null
}

/**
 * Stamped with the writing run's fence token, so a release only ever removes its own generation's
 * journal (Astra pass 9); readers ignore the extra field.
 */
export function writeKingudActivationTransaction(
  options: KingudActivationTransactionStoreOptions,
  transaction: KingudActivationTransaction
): Promise<void> {
  const fenceToken = currentKingudFence()?.token
  return writeAtomicKingudRemoteRecord(
    options,
    kingudActivationTransactionPath(options.host, options.remoteHome),
    serializeKingudActivationTransaction(fenceToken ? { ...transaction, fenceToken } : transaction)
  )
}
