/**
 * An kingud still serving in a distro that its activation record does not name (a Remove that
 * failed partway, say) is adopted, never killed: only it holds the data root's instance lock, so
 * launching the recorded slot would fail, and stopping it would need a terminal census C4 has no
 * channel to take. Adoption is proven first: the instance lock, the slot's readiness and the slot's
 * installed build must all name the same process. Then the record and pid file are rewritten under
 * the activation fence. A different version is then handled by the usual update gate.
 */
import {
  KINGUD_LOCK_FILE_NAME,
  parseKingudInstanceLockRecord
} from '../kingud/kingud-instance-lock'
import type { KingudActivationRecord } from '../ssh/kingud-activation-record'
import {
  readKingudActivationRecord,
  writeKingudActivationRecord
} from '../ssh/kingud-activation-record-store'
import { evaluateKingudActivation } from '../ssh/kingud-activation-gate'
import { withKingudActivationLock } from '../ssh/kingud-activation-lock'
import { sameKingudActivationRecord } from '../ssh/kingud-activation-transaction'
import { readKingudActivationTransaction } from '../ssh/kingud-activation-transaction-store'
import { readRemoteKingudManagedStopTarget } from '../ssh/kingud-managed-remote-stop'
import {
  kingudSlotDir,
  resolveKingudSlotIdentity,
  type KingudSlotOptions
} from '../ssh/kingud-recovery-slot'
import { KINGUD_PID_FILENAME } from '../ssh/kingud-remote-launch'
import {
  parseKingudReadinessWaitOutput,
  readKingudReadinessNowCommand
} from '../ssh/kingud-remote-readiness-wait'
import { readBoundedKingudRemoteRecord } from '../ssh/kingud-remote-record-file'
import { execKingudRemote } from '../ssh/kingud-remote-runtime-control'
import {
  KINGUD_INSTALL_MODEL,
  remoteInstallDirName,
  remoteInstallVersionDirRegex
} from '../ssh/remote-install-model'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { joinRemotePath } from '../ssh/ssh-remote-platform'

const LOCK_RECORD_MAX_BYTES = 64 * 1024
const UNRECORDED_KINGUD_CODE = 'wsl_kingud_unrecorded_instance_unverifiable'

export type WslKingudAdoption =
  | { outcome: 'none' }
  | { outcome: 'adopted'; version: string; pid: number; record: KingudActivationRecord }

export class WslKingudUnrecordedInstanceError extends Error {
  readonly code = UNRECORDED_KINGUD_CODE
  constructor(message: string) {
    super(message)
    this.name = 'WslKingudUnrecordedInstanceError'
  }
}

type LockHolder = { pid: number; version: string }

async function readLiveLockHolder(slot: KingudSlotOptions): Promise<LockHolder | null> {
  const lockPath = joinRemotePath(slot.host, slot.userDataDir, KINGUD_LOCK_FILE_NAME)
  const read = await readBoundedKingudRemoteRecord(slot, lockPath, LOCK_RECORD_MAX_BYTES)
  const lock = read.state === 'present' ? parseKingudInstanceLockRecord(read.raw) : null
  // A desktop holder is not an kingud; an absent or garbled lock names nobody to adopt.
  if (!lock || lock.role === 'desktop') {
    return null
  }
  const alive = await execKingudRemote(
    slot,
    `if kill -0 ${String(lock.pid)} 2>/dev/null; then echo LIVE; else echo DEAD; fi`
  )
  return alive.trim().split('\n').pop() === 'LIVE' ? { pid: lock.pid, version: lock.version } : null
}

async function readSlotPid(slot: KingudSlotOptions, version: string): Promise<number | null> {
  const pidFile = joinRemotePath(slot.host, kingudSlotDir(slot, version), KINGUD_PID_FILENAME)
  const raw = await execKingudRemote(slot, `cat ${shellEscape(pidFile)} 2>/dev/null || true`)
  const pid = Number.parseInt(raw.trim(), 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/** The holder's slot must publish readiness for this pid, from the build installed there. */
async function proveHolderServesItsSlot(
  slot: KingudSlotOptions,
  holder: LockHolder
): Promise<void> {
  const label = `An kingud (pid ${holder.pid}, ${holder.version}) is running in this distro but is not the recorded one`
  const dirName = remoteInstallDirName(KINGUD_INSTALL_MODEL, holder.version)
  if (!remoteInstallVersionDirRegex(KINGUD_INSTALL_MODEL).test(dirName)) {
    throw new WslKingudUnrecordedInstanceError(`${label}, and its version is not a slot name.`)
  }
  const target = await readRemoteKingudManagedStopTarget(slot, holder.version)
  if (target.state !== 'ready' || target.context.instance.pid !== holder.pid) {
    throw new WslKingudUnrecordedInstanceError(
      `${label}, and it cannot be identified: ${target.state === 'refused' ? target.reason : 'its readiness names another process.'}`
    )
  }
  const identity = await resolveKingudSlotIdentity(slot, holder.version)
  const readiness = parseKingudReadinessWaitOutput(
    slot.host,
    await execKingudRemote(slot, readKingudReadinessNowCommand(slot.host, identity.remoteDir))
  )
  const verdict = evaluateKingudActivation(
    readiness.state === 'ready' ? readiness.readiness : null,
    {
      buildHash: identity.buildHash,
      fullVersion: identity.version
    }
  )
  if (verdict.decision === 'reject') {
    throw new WslKingudUnrecordedInstanceError(`${label}, and ${verdict.reason}`)
  }
}

function adoptedRecord(
  record: KingudActivationRecord,
  version: string,
  now: Date
): KingudActivationRecord {
  if (record.active === version) {
    return record
  }
  const { activeAppVersion, previousAppVersion: _previousAppVersion, ...rest } = record
  return {
    ...rest,
    active: version,
    previous: record.active ?? record.previous,
    ...(record.active && activeAppVersion ? { previousAppVersion: activeAppVersion } : {}),
    activatedAt: now.toISOString(),
    // Its prelaunch snapshot belonged to another activation; rollback must not restore it here.
    snapshot: null
  }
}

/**
 * Adopts the kingud holding the instance lock when the record or its slot's pid file does not
 * name it. Anything unprovable refuses: a launch would only lose the instance lock to it.
 */
export async function adoptUnrecordedWslKingud(
  slot: KingudSlotOptions,
  record: KingudActivationRecord,
  now: () => Date = () => new Date()
): Promise<WslKingudAdoption> {
  const holder = await readLiveLockHolder(slot)
  if (!holder) {
    return { outcome: 'none' }
  }
  if (
    record.active === holder.version &&
    (await readSlotPid(slot, holder.version)) === holder.pid
  ) {
    return { outcome: 'none' }
  }
  await proveHolderServesItsSlot(slot, holder)
  return withKingudActivationLock(
    slot,
    async () => {
      const current = await readKingudActivationRecord(slot)
      if (!sameKingudActivationRecord(current, record)) {
        throw new WslKingudUnrecordedInstanceError(
          'The activation record changed while an unrecorded kingud was being adopted. Retry.'
        )
      }
      if (await readKingudActivationTransaction(slot)) {
        throw new WslKingudUnrecordedInstanceError(
          'An interrupted activation is pending, so an unrecorded kingud cannot be adopted yet.'
        )
      }
      const again = await readLiveLockHolder(slot)
      if (again?.pid !== holder.pid || again.version !== holder.version) {
        throw new WslKingudUnrecordedInstanceError(
          'The unrecorded kingud changed while it was being adopted. Retry.'
        )
      }
      const pidFile = joinRemotePath(
        slot.host,
        kingudSlotDir(slot, holder.version),
        KINGUD_PID_FILENAME
      )
      await execKingudRemote(
        slot,
        `(umask 077 && printf '%s\\n' ${String(holder.pid)} > ${shellEscape(pidFile)})`
      )
      const next = adoptedRecord(current, holder.version, now())
      if (next !== current) {
        await writeKingudActivationRecord(slot, next)
      }
      return {
        outcome: 'adopted' as const,
        version: holder.version,
        pid: holder.pid,
        record: next
      }
    },
    () => {
      throw new WslKingudUnrecordedInstanceError(
        'Another Kingu is changing this distro’s server, so an unrecorded kingud cannot be adopted now.'
      )
    }
  )
}
