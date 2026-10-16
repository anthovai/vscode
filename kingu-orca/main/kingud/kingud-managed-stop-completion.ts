/**
 * Asking one kingud instance to stop and proving that it did.
 *
 * Runs as a short-lived command on the execution host. It never signals: it writes the
 * instance-bound request the running kingud watches for, then observes until the instance is
 * gone. `exited` needs proof — no process with that PID, or a PID whose kernel identity shows it
 * now belongs to another process. A wall-clock disagreement, or anything the host cannot answer,
 * is `unverifiable`, never exit.
 */
import { setTimeout as delay } from 'node:timers/promises'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  KingudManagedStopRequestSchema,
  kingudManagedStopRequestKey,
  type KingudManagedStopInstance,
  type KingudManagedStopRequest,
  type KingudManagedStopVerdict
} from '../../shared/kingud-stop-request'
import {
  compareKingudProcessIdentity,
  recordedKingudProcessIncarnation,
  type KingudProcessIdentityReaders,
  type KingudRecordedIdentity
} from './kingud-process-start-time'
import { hasErrorCode, inspectProcessSignal } from '../daemon/daemon-process-inspection'
import { persistKingudCompletedStopReceipt } from './kingud-completed-stop-receipt'
import { readKingudManagedStopDecision } from './kingud-managed-stop-decision'
import { withdrawKingudManagedStopRequest } from './kingud-managed-stop-cancellation'
import {
  kingudInstanceLockNames,
  kingudManagedStopRequestPath,
  readKingudInstanceLockNaming,
  readKingudManagedStopRequest
} from './kingud-managed-stop-request'
import {
  KINGUD_STOP_COMPLETION_POLL_ATTEMPTS,
  KINGUD_STOP_COMPLETION_POLL_MS
} from './kingud-stop-deadlines'

export type KingudProcessProbe = (pid: number) => 'alive' | 'missing' | 'unverifiable'

export type KingudManagedStopCompletionOptions = KingudProcessIdentityReaders & {
  probeProcess?: KingudProcessProbe
  sleep?: () => Promise<void>
  attempts?: number
  now?: () => Date
}

function defaultProbe(pid: number): ReturnType<KingudProcessProbe> {
  const signal = inspectProcessSignal(pid)
  // EPERM proves some process holds the PID; it cannot prove ours exited.
  return signal === 'occupied' ? 'alive' : signal === 'missing' ? 'missing' : 'unverifiable'
}

function observeInstance(
  instance: KingudManagedStopInstance,
  recorded: KingudRecordedIdentity,
  options: KingudManagedStopCompletionOptions
): KingudManagedStopVerdict {
  const probe = (options.probeProcess ?? defaultProbe)(instance.pid)
  if (probe !== 'alive') {
    return probe === 'missing' ? 'exited' : 'unverifiable'
  }
  // Only a kernel identity (or a stored creation time) proves reuse; an unknown one stays live.
  const identity = compareKingudProcessIdentity(instance.pid, recorded, options)
  return identity === 'differs' ? 'exited' : identity === 'unproven' ? 'unverifiable' : 'live'
}

/** An older client's request lacks the incarnation; the lock still naming the instance has it. */
function recordedIdentity(instance: KingudManagedStopInstance): KingudRecordedIdentity {
  if (recordedKingudProcessIncarnation(instance)) {
    return instance
  }
  let record: KingudRecordedIdentity | null = null
  try {
    record = readKingudInstanceLockNaming(instance)
  } catch {
    return instance
  }
  const incarnation = record ? recordedKingudProcessIncarnation(record) : null
  return incarnation ? { ...instance, ...incarnation } : instance
}

/** Writes the request only while the lock still names this instance, then waits for exit. */
export async function completeKingudManagedStop(
  input: KingudManagedStopRequest,
  options: KingudManagedStopCompletionOptions = {}
): Promise<KingudManagedStopVerdict> {
  const request = KingudManagedStopRequestSchema.parse(input)
  const attempts = options.attempts ?? KINGUD_STOP_COMPLETION_POLL_ATTEMPTS
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 240) {
    throw new Error('kingud_managed_stop_invalid_attempts')
  }
  const completed = (): 'exited' => {
    persistKingudCompletedStopReceipt(request, (options.now ?? (() => new Date()))())
    return 'exited'
  }
  const recorded = recordedIdentity(request.instance)
  let verdict = observeInstance(request.instance, recorded, options)
  if (verdict !== 'live') {
    return verdict === 'exited' ? completed() : verdict
  }
  if (!lockStillNamesInstance(request.instance)) {
    // The process lives but no longer owns the lock it published: it is not ours to address.
    return 'unverifiable'
  }
  if (readKingudManagedStopDecision(request) === 'canceled') {
    // A cancelled transaction is never reissued; its kingud keeps running.
    return 'live'
  }
  const requestPath = kingudManagedStopRequestPath(request.instance)
  if (!existingRequestMatches(requestPath, request)) {
    return 'unverifiable'
  }
  if (!writeDurableSecureJsonFile(requestPath, request)) {
    throw new Error('kingud_managed_stop_request_permissions_unconfirmed')
  }
  // A cancel that won between the check above and this write found no file to remove.
  if (readKingudManagedStopDecision(request) === 'canceled') {
    withdrawKingudManagedStopRequest(request)
    return 'live'
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    await (options.sleep ?? (() => delay(KINGUD_STOP_COMPLETION_POLL_MS)))()
    verdict = observeInstance(request.instance, recorded, options)
    if (verdict !== 'live') {
      return verdict === 'exited' ? completed() : verdict
    }
  }
  return 'live'
}

function lockStillNamesInstance(instance: KingudManagedStopInstance): boolean {
  try {
    return kingudInstanceLockNames(instance)
  } catch {
    return false
  }
}

/** A request already present must be this one; another transaction's request is not ours. */
function existingRequestMatches(path: string, request: KingudManagedStopRequest): boolean {
  try {
    return (
      kingudManagedStopRequestKey(readKingudManagedStopRequest(path)) ===
      kingudManagedStopRequestKey(request)
    )
  } catch (error) {
    return hasErrorCode(error, 'ENOENT')
  }
}
