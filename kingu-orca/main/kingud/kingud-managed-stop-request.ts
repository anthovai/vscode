/** Validating an instance-bound stop request before the running kingud acts on it. */
import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import {
  KINGUD_MANAGED_STOP_REQUEST_MAX_BYTES,
  KINGUD_MANAGED_STOP_REQUEST_PREFIX,
  KingudManagedStopRequestSchema,
  type KingudManagedStopContext,
  type KingudManagedStopInstance,
  type KingudManagedStopRequest
} from '../../shared/kingud-stop-request'
import { readKingudInstanceLockRecord, type KingudLockRecord } from './kingud-instance-lock'

/** Keyed by the lock nonce, so a request for a previous instance is never this one's. */
export function kingudManagedStopRequestPath(instance: KingudManagedStopInstance): string {
  const digest = createHash('sha256').update(instance.nonce).digest('hex')
  return join(dirname(instance.lockPath), `${KINGUD_MANAGED_STOP_REQUEST_PREFIX}.${digest}`)
}

export function readKingudManagedStopRequest(path: string): KingudManagedStopRequest {
  if (!lstatSync(path).isFile()) {
    throw new Error('kingud_managed_stop_request_not_regular_file')
  }
  const { buffer } = readNodeFileSyncWithinLimit(path, KINGUD_MANAGED_STOP_REQUEST_MAX_BYTES)
  return KingudManagedStopRequestSchema.parse(JSON.parse(buffer.toString('utf8')))
}

export function sameKingudManagedStopInstance(
  left: KingudManagedStopInstance,
  right: Pick<KingudManagedStopInstance, 'pid' | 'startedAtMs' | 'nonce'>
): boolean {
  return (
    left.pid === right.pid && left.startedAtMs === right.startedAtMs && left.nonce === right.nonce
  )
}

/** Whether the instance lock still names exactly this instance. */
export function kingudInstanceLockNames(instance: KingudManagedStopInstance): boolean {
  return readKingudInstanceLockNaming(instance) !== null
}

/** The lock record, only while it still names exactly this instance. */
export function readKingudInstanceLockNaming(
  instance: KingudManagedStopInstance
): KingudLockRecord | null {
  if (!lstatSync(instance.lockPath).isFile()) {
    return null
  }
  const record = readKingudInstanceLockRecord(instance.lockPath)
  return record !== null && sameKingudManagedStopInstance(instance, record) ? record : null
}

/** Throws unless the request names this running instance and its lock is still ours. */
export function validateKingudManagedStopRequest(
  context: KingudManagedStopContext,
  requestPath: string
): KingudManagedStopRequest {
  const request = readKingudManagedStopRequest(requestPath)
  if (
    request.version !== context.version ||
    request.runtimeId !== context.runtimeId ||
    // Resolved: a Windows client names the lock with `/`, kingud's own path.join with `\`.
    resolve(request.instance.lockPath) !== resolve(context.instance.lockPath) ||
    !sameKingudManagedStopInstance(request.instance, context.instance)
  ) {
    throw new Error('kingud_managed_stop_request_identity_mismatch')
  }
  if (!kingudInstanceLockNames(context.instance)) {
    throw new Error('kingud_managed_stop_instance_lock_changed')
  }
  return request
}
