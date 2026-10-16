/** Durable outcomes of a managed stop, in the data root beside the instance lock. */
import { lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { z } from 'zod'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import { hasErrorCode } from '../daemon/daemon-process-inspection'
import {
  KINGUD_STOP_RECEIPTS_DIRNAME,
  KingudCompletedStopReceiptSchema,
  KingudManagedStopRequestSchema,
  KingudDaemonRetirementRecordSchema,
  kingudManagedStopRequestKey,
  type KingudCompletedStopReceipt,
  type KingudDaemonRetirementRecord,
  type KingudManagedStopRequest
} from '../../shared/kingud-stop-request'

const RECEIPT_MAX_BYTES = 64 * 1024

export type ReceiptKind = 'completed' | 'retirement' | 'decision'

export function kingudStopReceiptPath(
  request: KingudManagedStopRequest,
  kind: ReceiptKind
): string {
  const { transactionId, instance } = KingudManagedStopRequestSchema.parse(request)
  const suffix = kind === 'completed' ? '' : `.${kind}`
  return join(
    dirname(instance.lockPath),
    KINGUD_STOP_RECEIPTS_DIRNAME,
    `${transactionId}${suffix}.json`
  )
}

/** `null` when absent; a receipt for a different request throws rather than reading as absent. */
export function readKingudStopReceipt<T extends { request: KingudManagedStopRequest }>(
  request: KingudManagedStopRequest,
  kind: ReceiptKind,
  schema: z.ZodType<T>
): T | null {
  const path = kingudStopReceiptPath(request, kind)
  try {
    if (!lstatSync(path).isFile()) {
      throw new Error('kingud_stop_receipt_unverifiable')
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null
    }
    throw error
  }
  const receipt = schema.parse(
    JSON.parse(readNodeFileSyncWithinLimit(path, RECEIPT_MAX_BYTES).buffer.toString('utf8'))
  )
  if (kingudManagedStopRequestKey(receipt.request) !== kingudManagedStopRequestKey(request)) {
    throw new Error('kingud_stop_receipt_mismatch')
  }
  return receipt
}

function writeReceipt(
  request: KingudManagedStopRequest,
  kind: ReceiptKind,
  receipt: unknown
): void {
  if (!writeDurableSecureJsonFile(kingudStopReceiptPath(request, kind), receipt)) {
    throw new Error('kingud_stop_receipt_permissions_unconfirmed')
  }
}

export function readKingudCompletedStopReceipt(
  request: KingudManagedStopRequest
): KingudCompletedStopReceipt | null {
  return readKingudStopReceipt(request, 'completed', KingudCompletedStopReceiptSchema)
}

/**
 * Called only after exit is proven; rewriting an existing receipt re-runs its fsync. A retiring
 * request whose kingud left no retirement record reports `unverifiable`, never `retired`.
 */
export function persistKingudCompletedStopReceipt(
  request: KingudManagedStopRequest,
  exitedAt: Date
): KingudCompletedStopReceipt {
  const parsed = KingudManagedStopRequestSchema.parse(request)
  const retirement = parsed.retireIdleDaemon
    ? (readKingudDaemonRetirementRecord(parsed)?.retirement ?? 'unverifiable')
    : undefined
  const receipt = readKingudCompletedStopReceipt(parsed) ?? {
    schemaVersion: 1 as const,
    kind: 'kingud_managed_stop_completed' as const,
    request: parsed,
    exitedAt: exitedAt.toISOString(),
    ...(retirement ? { retirement } : {})
  }
  writeReceipt(parsed, 'completed', receipt)
  return receipt
}

export function readKingudDaemonRetirementRecord(
  request: KingudManagedStopRequest
): KingudDaemonRetirementRecord | null {
  return readKingudStopReceipt(request, 'retirement', KingudDaemonRetirementRecordSchema)
}

export function persistKingudDaemonRetirementRecord(
  request: KingudManagedStopRequest,
  outcome: Pick<KingudDaemonRetirementRecord, 'retirement' | 'liveSessions' | 'reason'>
): void {
  writeReceipt(request, 'retirement', {
    schemaVersion: 1,
    kind: 'kingud_managed_stop_retirement',
    request: KingudManagedStopRequestSchema.parse(request),
    ...outcome
  })
}
