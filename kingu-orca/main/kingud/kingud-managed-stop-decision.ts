/**
 * Arbitrating a managed request between the kingud acting on it and a client cancelling it.
 *
 * Both sides race to create one decision file per transaction with a hard link, which fails if
 * the file exists. Exactly one wins, and the loser reads the winner's decision, so a cancel can
 * never report success for a stop that kingud already began.
 */
import { linkSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  KingudManagedStopDecisionSchema,
  KingudManagedStopRequestSchema,
  type KingudManagedStopDecision,
  type KingudManagedStopRequest
} from '../../shared/kingud-stop-request'
import { kingudStopReceiptPath, readKingudStopReceipt } from './kingud-completed-stop-receipt'
import { hasErrorCode } from '../daemon/daemon-process-inspection'

export type KingudManagedStopDecisionValue = KingudManagedStopDecision['decision']

export function readKingudManagedStopDecision(
  request: KingudManagedStopRequest
): KingudManagedStopDecisionValue | null {
  return (
    readKingudStopReceipt(request, 'decision', KingudManagedStopDecisionSchema)?.decision ?? null
  )
}

/** Returns the decision that stands: ours if we created it first, otherwise the other side's. */
export function claimKingudManagedStopDecision(
  input: KingudManagedStopRequest,
  decision: KingudManagedStopDecisionValue
): KingudManagedStopDecisionValue {
  const request = KingudManagedStopRequestSchema.parse(input)
  const path = kingudStopReceiptPath(request, 'decision')
  const staged = `${path}.${process.pid}.${randomUUID()}.staged`
  const record: KingudManagedStopDecision = {
    schemaVersion: 1,
    kind: 'kingud_managed_stop_decision',
    request,
    decision
  }
  if (!writeDurableSecureJsonFile(staged, record)) {
    rmSync(staged, { force: true })
    throw new Error('kingud_managed_stop_decision_permissions_unconfirmed')
  }
  try {
    linkSync(staged, path)
    return decision
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error
    }
    const standing = readKingudManagedStopDecision(request)
    if (!standing) {
      throw new Error('kingud_managed_stop_decision_unverifiable')
    }
    return standing
  } finally {
    rmSync(staged, { force: true })
  }
}
