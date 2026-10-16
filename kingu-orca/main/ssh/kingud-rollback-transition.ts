/** The locked, journaled half of `rollbackKingud`. */
import { kingudRemoteBaseDir } from './kingud-remote-windows-node'
import { randomUUID } from 'node:crypto'
import type { KingudRollbackOptions, KingudRollbackResult } from './kingud-remote-rollback'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import { withRolledBackVersion } from './kingud-activation-record'
import { writeKingudActivationRecord } from './kingud-activation-record-store'
import { launchAndJudgeKingudSlot } from './kingud-candidate-launch-verdict'
import { assessKingudRollback } from './kingud-update-plan'
import { KINGUD_LOG_FILENAME } from './kingud-remote-launch'
import {
  captureKingudStateSnapshotCommand,
  newestStateMtimeCommand,
  kingudRollbackRescueDirName,
  parseNewestStateMtimeSeconds,
  parseKingudSnapshotCapture,
  parseKingudSnapshotPresence,
  parseKingudSnapshotRestore,
  probeKingudStateSnapshotCommand,
  restoreKingudStateSnapshotCommand
} from './kingud-state-snapshot'
import { joinRemotePath } from './ssh-remote-platform'
import type { KingudActivationLockControl } from './kingud-activation-lock'
import {
  rollbackStartingState,
  type KingudRollbackTransaction
} from './kingud-activation-transaction'
import {
  createKingudRollbackTransaction,
  withKingudRollbackPhase,
  withKingudRollbackRescue
} from './kingud-activation-transaction-transitions'
import { writeKingudActivationTransaction } from './kingud-activation-transaction-store'
import { execKingudRemoteOr, withoutAbortSignal } from './kingud-remote-runtime-control'
import { execKingudStateMutationOr } from './kingud-state-mutation-exec'
import {
  kingudSlotDir,
  resolveKingudSlotIdentity,
  type KingudSlotIdentity
} from './kingud-recovery-slot'
import { kingudSnapshotPath } from './kingud-incumbent-recovery'
import {
  putTransactionIncumbentBack,
  restoreAfterRejectedCandidate
} from './kingud-transaction-incumbent'
import {
  readKingudRollbackBarrierTarget,
  rollbackBarrierRefusal,
  stopIncumbentBehindTerminalBarrier
} from './kingud-rollback-terminal-barrier'
import { withKingudLogTail } from './kingud-remote-log-tail'
import { errorMessage } from '../../shared/error-message'

async function stateWritesSinceActivation(options: KingudRollbackOptions): Promise<boolean | null> {
  const activatedAtSeconds = Math.floor(Date.parse(options.record.activatedAt ?? '') / 1000)
  if (!Number.isFinite(activatedAtSeconds)) {
    return null
  }
  const newest = parseNewestStateMtimeSeconds(
    await execKingudRemoteOr(
      options,
      newestStateMtimeCommand(
        options.host,
        options.userDataDir,
        kingudRemoteBaseDir(options.host, options.remoteHome)
      )
    )
  )
  return newest === null ? null : newest >= activatedAtSeconds
}

export async function rollbackKingudLocked(
  options: KingudRollbackOptions,
  lock: KingudActivationLockControl
): Promise<KingudRollbackResult> {
  const now = options.now ?? ((): Date => new Date())
  const snapshot = options.record.snapshot
  const presence = snapshot
    ? parseKingudSnapshotPresence(
        await execKingudRemoteOr(
          options,
          probeKingudStateSnapshotCommand(
            options.host,
            kingudSnapshotPath(options, snapshot.dirName),
            kingudRemoteBaseDir(options.host, options.remoteHome)
          )
        )
      )
    : 'absent'
  const safety = assessKingudRollback({
    record: options.record,
    snapshotPresent: presence === 'unverifiable' ? null : presence === 'present',
    census: options.census,
    targetDaemonProtocol: options.targetDaemonProtocol,
    stateWritesSinceActivation: await stateWritesSinceActivation(options)
  })
  if (safety.safety === 'unsafe') {
    return { outcome: 'refused', code: safety.code, reason: safety.reason }
  }
  if (!snapshot || !options.record.active) {
    return {
      outcome: 'refused',
      code: 'kingud_rollback_no_active',
      reason: 'No kingud version is active on this host, so there is nothing to roll back from.'
    }
  }
  let incumbent: KingudSlotIdentity
  try {
    incumbent = await resolveKingudSlotIdentity(options, options.record.active)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return {
      outcome: 'refused',
      code: 'kingud_rollback_active_identity_unverifiable',
      reason: `The active kingud identity could not be verified: ${errorMessage(error)} Nothing was changed.`
    }
  }

  const barrierTarget = await readKingudRollbackBarrierTarget(options, incumbent.version)
  if (barrierTarget.state === 'refused') {
    return { outcome: 'refused', code: barrierTarget.code, reason: barrierTarget.reason }
  }

  const startedAt = now()
  let transaction: KingudRollbackTransaction = createKingudRollbackTransaction({
    transactionId: randomUUID(),
    incumbentVersion: incumbent.version,
    targetVersion: safety.target,
    recordBefore: options.record,
    recordAfter: withRolledBackVersion(options.record, startedAt),
    rescueDirName: kingudRollbackRescueDirName(incumbent.version, startedAt.getTime()),
    now: startedAt
  })
  await writeKingudActivationTransaction(options, transaction)
  lock.retainOnError()
  // Past the first mutation a cancel would strand a stopped host, so the run finishes or rolls back.
  options = withoutAbortSignal(options)

  // The census above was taken while kingud admitted work; this stop is the proof that counts.
  const blocked = rollbackBarrierRefusal(
    await stopIncumbentBehindTerminalBarrier(
      options,
      transaction.transactionId,
      barrierTarget.context
    )
  )
  if (blocked) {
    if (blocked.retainFence) {
      lock.retain()
    }
    const recovered = blocked.restartIncumbent
      ? ` ${await putIncumbentBack(options, lock, transaction, incumbent)}`
      : ''
    return { outcome: blocked.outcome, code: blocked.code, reason: blocked.reason + recovered }
  }
  transaction = withKingudRollbackPhase(transaction, 'incumbent-stopped', now())
  await writeKingudActivationTransaction(options, transaction)

  const rescue = parseKingudSnapshotCapture(
    await execKingudStateMutationOr(
      options,
      captureKingudStateSnapshotCommand(
        options.host,
        options.userDataDir,
        kingudSnapshotPath(options, transaction.rescue.dirName),
        kingudRemoteBaseDir(options.host, options.remoteHome)
      )
    )
  )
  if (rescue === 'failed') {
    const recovered = await putIncumbentBack(options, lock, transaction, incumbent)
    return {
      outcome: 'failed',
      code: 'kingud_rollback_rescue_snapshot_failed',
      reason:
        'The current state could not be preserved in a rescue snapshot, so the data root was ' +
        `not replaced. ${recovered}`
    }
  }
  transaction = withKingudRollbackRescue(transaction, rescue, now())
  await writeKingudActivationTransaction(options, transaction)

  // Why between stop and start: the older build must never load the newer build's state.
  const restored = parseKingudSnapshotRestore(
    await execKingudStateMutationOr(
      options,
      restoreKingudStateSnapshotCommand(
        options.host,
        options.userDataDir,
        kingudSnapshotPath(options, snapshot.dirName),
        kingudRemoteBaseDir(options.host, options.remoteHome)
      )
    )
  )
  if (restored !== 'restored') {
    const recovered = await putIncumbentBack(options, lock, transaction, incumbent)
    return {
      outcome: 'failed',
      code: 'kingud_rollback_restore_failed',
      reason: `The pre-activation snapshot could not be restored (${restored}). ${recovered}`
    }
  }
  transaction = withKingudRollbackPhase(transaction, 'rollback-state-restored', now())
  await writeKingudActivationTransaction(options, transaction)

  const targetDir = kingudSlotDir(options, safety.target)
  const { verdict, launchError } = await launchAndJudgeKingudSlot(options, {
    remoteInstallDir: targetDir,
    fullVersion: safety.target,
    buildHash: options.targetBuildHash
  })
  if (verdict.decision === 'reject') {
    const reason =
      launchError === undefined
        ? verdict.reason
        : `It failed while starting: ${errorMessage(launchError)}`
    const recovered = await restoreAfterRejectedCandidate(options, lock, {
      launchedDir: targetDir,
      launchedVersion: safety.target,
      transactionStartedAt: transaction.startedAt,
      incumbent,
      restoreState: rescueVerdict(transaction),
      launchedFromState: rollbackStartingState(transaction)
    })
    return {
      outcome: 'failed',
      code: launchError === undefined ? verdict.code : 'kingud_rollback_target_launch_failed',
      reason: await withKingudLogTail(
        options,
        targetDir,
        `The rollback target ${safety.target} did not come up healthy: ${reason} ${recovered} ` +
          `Its stderr is at ${joinRemotePath(options.host, targetDir, KINGUD_LOG_FILENAME)}.`
      )
    }
  }

  // The record is written last: until the target is proven serving, `active` still names the
  // version an operator would need to bring back.
  transaction = withKingudRollbackPhase(transaction, 'target-ready', now())
  await writeKingudActivationTransaction(options, transaction)
  await writeKingudActivationRecord(options, transaction.recordAfter)
  return {
    outcome: 'rolled-back',
    target: safety.target,
    discarded: safety.safety === 'lossy' ? safety.discards : [],
    verdict
  }
}

type RestoreState = Parameters<typeof putTransactionIncumbentBack>[2]['restoreState']

function rescueVerdict(transaction: KingudRollbackTransaction): RestoreState {
  return transaction.rescue.state === 'pending' ? null : transaction.rescue
}

/** Puts the rescued state back when it was replaced, then restarts the incumbent. */
async function putIncumbentBack(
  options: KingudRollbackOptions,
  lock: KingudActivationLockControl,
  transaction: KingudRollbackTransaction,
  incumbent: KingudSlotIdentity
): Promise<string> {
  const failure = await putTransactionIncumbentBack(options, lock, {
    transactionStartedAt: transaction.startedAt,
    launchedVersion: null,
    incumbent,
    restoreState: rescueVerdict(transaction)
  })
  return failure ?? `kingud ${incumbent.version} was restored and is serving again.`
}
