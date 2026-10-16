/** Withdrawing a managed stop request that the running kingud has not acted on yet. */
import { rmSync } from 'node:fs'
import type {
  KingudManagedStopCancellation,
  KingudManagedStopRequest
} from '../../shared/kingud-stop-request'
import { claimKingudManagedStopDecision } from './kingud-managed-stop-decision'
import {
  kingudManagedStopRequestPath,
  readKingudManagedStopRequest
} from './kingud-managed-stop-request'

/** `dispatched` means kingud already began stopping; only its completion can say how it ended. */
export function cancelKingudManagedStop(
  request: KingudManagedStopRequest
): KingudManagedStopCancellation['outcome'] {
  const outcome = claimKingudManagedStopDecision(request, 'canceled')
  if (outcome === 'canceled') {
    withdrawKingudManagedStopRequest(request)
  }
  return outcome
}

/** Removes the request file only while it still carries this transaction. */
export function withdrawKingudManagedStopRequest(request: KingudManagedStopRequest): void {
  const path = kingudManagedStopRequestPath(request.instance)
  try {
    if (readKingudManagedStopRequest(path).transactionId === request.transactionId) {
      rmSync(path, { force: true })
    }
  } catch {
    // Absent or another transaction's request: the standing decision already fences this one.
  }
}
