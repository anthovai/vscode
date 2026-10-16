/**
 * Stopping one remote kingud instance through its instance-bound request, never a signal.
 *
 * The client names the instance from two host records that must agree: the slot's readiness
 * payload (runtime ID, PID, capability) and the data root's instance lock (PID, start time,
 * nonce). The slot's own `kingud.js` then writes the request and proves exit on the host.
 */
import { randomUUID } from 'node:crypto'
import { shellEscape } from './ssh-connection-utils'
import { selectKingudSlotRuntimeCommand } from './kingud-remote-runtime'
import {
  parseKingudReadinessWaitOutput,
  readKingudReadinessNowCommand
} from './kingud-remote-readiness-wait'
import { execKingudRemote } from './kingud-remote-runtime-control'
import { readBoundedKingudRemoteRecord } from './kingud-remote-record-file'
import { kingudSlotDir, type KingudSlotOptions } from './kingud-recovery-slot'
import { isWindowsRemoteHost, joinRemotePath } from './ssh-remote-platform'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import {
  kingudWindowsNodeCommandLine,
  kingudWindowsSlotOpCommand,
  readKingudWindowsEncodedAnswer
} from './kingud-remote-windows-node'
import { KINGUD_WINDOWS_RUNTIME_MARKER } from './kingud-windows-host-script'
import {
  KINGUD_LOCK_FILE_NAME,
  parseKingudInstanceLockRecord
} from '../kingud/kingud-instance-lock'
import {
  KINGUD_CANCEL_MANAGED_STOP_FLAG,
  KINGUD_COMPLETE_MANAGED_STOP_FLAG,
  KINGUD_MANAGED_STOP_REQUEST_FILE_FLAG,
  KINGUD_STOP_REQUESTS_CAPABILITY,
  KingudManagedStopCancellationSchema,
  KingudManagedStopCompletionSchema,
  type KingudManagedStopCancellation,
  type KingudManagedStopCompletion,
  type KingudManagedStopContext,
  type KingudManagedStopRequest
} from '../../shared/kingud-stop-request'

const LOCK_RECORD_MAX_BYTES = 64 * 1024

export type KingudManagedStopTarget =
  | { state: 'ready'; context: KingudManagedStopContext }
  | { state: 'refused'; verdict: 'unverifiable'; code: string; reason: string }

function refused(code: string, reason: string): KingudManagedStopTarget {
  return { state: 'refused', verdict: 'unverifiable', code, reason }
}

/** Names the running instance of `version`, or says why the host could not prove which it is. */
export async function readRemoteKingudManagedStopTarget(
  options: KingudSlotOptions,
  version: string
): Promise<KingudManagedStopTarget> {
  const slotDir = kingudSlotDir(options, version)
  const readiness = parseKingudReadinessWaitOutput(
    options.host,
    await execKingudRemote(options, readKingudReadinessNowCommand(options.host, slotDir))
  )
  if (readiness.state !== 'ready' || !readiness.readiness.health) {
    return refused(
      'kingud_managed_stop_readiness_unverifiable',
      `kingud ${version} has no readable readiness record, so the running instance is unknown.`
    )
  }
  const { health, runtimeId } = readiness.readiness
  if (health.stopRequests !== KINGUD_STOP_REQUESTS_CAPABILITY) {
    return refused(
      'kingud_managed_stop_unsupported',
      `kingud ${version} predates managed stop requests; it can only be stopped by signal.`
    )
  }
  const lockPath = joinRemotePath(options.host, options.userDataDir, KINGUD_LOCK_FILE_NAME)
  const lockRead = await readBoundedKingudRemoteRecord(options, lockPath, LOCK_RECORD_MAX_BYTES)
  const lock = lockRead.state === 'present' ? parseKingudInstanceLockRecord(lockRead.raw) : null
  if (!lock || lock.pid !== health.pid || !runtimeId) {
    return refused(
      'kingud_managed_stop_instance_unverifiable',
      `The instance lock does not name the kingud ${version} that published readiness.`
    )
  }
  return {
    state: 'ready',
    context: {
      version,
      runtimeId,
      instance: {
        pid: lock.pid,
        startedAtMs: lock.startedAtMs,
        // Older slots drop these; newer ones prove identity without the drifting wall clock.
        ...(lock.linuxStartTicks && lock.bootId
          ? { linuxStartTicks: lock.linuxStartTicks, bootId: lock.bootId }
          : {}),
        nonce: lock.nonce,
        lockPath
      }
    }
  }
}

export async function completeRemoteKingudManagedStop(
  options: KingudSlotOptions,
  request: KingudManagedStopRequest
): Promise<KingudManagedStopCompletion> {
  return KingudManagedStopCompletionSchema.parse(
    await runSlotCommand(options, request, KINGUD_COMPLETE_MANAGED_STOP_FLAG)
  )
}

export async function cancelRemoteKingudManagedStop(
  options: KingudSlotOptions,
  request: KingudManagedStopRequest
): Promise<KingudManagedStopCancellation> {
  return KingudManagedStopCancellationSchema.parse(
    await runSlotCommand(options, request, KINGUD_CANCEL_MANAGED_STOP_FLAG)
  )
}

/** Runs the slot's own build, which owns the request format it is asked to write. */
async function runSlotCommand(
  options: KingudSlotOptions,
  request: KingudManagedStopRequest,
  flag: string
): Promise<unknown> {
  const slotDir = kingudSlotDir(options, request.version)
  const entry = joinRemotePath(options.host, slotDir, 'kingud.js')
  const output = isWindowsRemoteHost(options.host)
    ? await runWindowsSlotCommand(options, slotDir, entry, request, flag)
    : await execKingudRemote(
        options,
        `${selectKingudSlotRuntimeCommand(options.host, slotDir, options.nodePath)} && ` +
          `"$kingud_runtime" ${shellEscape(entry)} ${flag} ${shellEscape(JSON.stringify(request))}`
      )
  const line = output
    .trim()
    .split('\n')
    .findLast((candidate) => candidate.trim().startsWith('{'))
  if (!line) {
    throw new Error('kingud managed stop command returned no verifiable answer')
  }
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('kingud managed stop command returned no verifiable answer')
  }
  // The answer must be about this exact request, not another transaction's.
  if (!('transactionId' in parsed) || parsed.transactionId !== request.transactionId) {
    throw new Error('kingud managed stop command answered another transaction')
  }
  return parsed
}

/** Windows passes the request as a staged file: JSON on a command line meets two quoting layers. */
async function runWindowsSlotCommand(
  options: KingudSlotOptions,
  slotDir: string,
  entry: string,
  request: KingudManagedStopRequest,
  flag: string
): Promise<string> {
  const runtime = readKingudWindowsEncodedAnswer(
    await execKingudRemote(
      options,
      kingudWindowsSlotOpCommand(options.host, slotDir, 'slot-runtime', [slotDir])
    ),
    KINGUD_WINDOWS_RUNTIME_MARKER
  )
  if (!runtime) {
    throw new Error('The Windows host did not name the runtime this kingud slot needs.')
  }
  const staged = joinRemotePath(options.host, slotDir, `.kingud-stop-command-${randomUUID()}.json`)
  let removeStaged = true
  try {
    await options.conn.writeFile(staged, JSON.stringify(request), {
      hostPlatform: options.host,
      signal: options.signal
    })
    return await execKingudRemote(
      options,
      kingudWindowsNodeCommandLine(runtime, [
        entry,
        flag,
        KINGUD_MANAGED_STOP_REQUEST_FILE_FLAG,
        staged
      ])
    )
  } catch (error) {
    // The command may still be reading it.
    removeStaged = !isUnconfirmedSshCommandTermination(error)
    throw error
  } finally {
    if (removeStaged) {
      await execKingudRemote(
        options,
        kingudWindowsSlotOpCommand(options.host, slotDir, 'remove-file', [staged])
      ).catch(() => {})
    }
  }
}
