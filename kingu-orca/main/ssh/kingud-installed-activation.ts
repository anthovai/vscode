/**
 * The locked half of a deploy: stop, snapshot, start and commit, journaled at every step.
 *
 * The journal is durable before the first mutation, so a crash at any point leaves enough on
 * the host for `recoverInterruptedKingudActivation` to finish or undo it. A run that ends with
 * the host provably back on one slot drops the fence; one that cannot prove it keeps it.
 */
import { kingudRemoteBaseDir } from './kingud-remote-windows-node'
import { randomUUID } from 'node:crypto'
import type { KingudDeployOptions, KingudDeployResult } from './kingud-remote-deploy'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import {
  withActivatedVersion,
  type KingudActivationRecord,
  type KingudStateSnapshot
} from './kingud-activation-record'
import {
  readKingudActivationRecord,
  writeKingudActivationRecord
} from './kingud-activation-record-store'
import { launchAndJudgeKingudSlot } from './kingud-candidate-launch-verdict'
import { planKingudUpdate, type KingudTerminalCensus } from './kingud-update-plan'
import { CURRENT_KINGUD_DAEMON_PROTOCOL } from './kingud-daemon-protocol-crossing'
import { KINGUD_LOG_FILENAME } from './kingud-remote-launch'
import {
  captureKingudStateSnapshotCommand,
  kingudSnapshotDirName,
  parseKingudSnapshotCapture
} from './kingud-state-snapshot'
import { joinRemotePath } from './ssh-remote-platform'
import { computeLocalKingudBuildHash } from './kingud-local-build-hash'
import { preflightInstalledKingud } from './kingud-remote-preflight'
import type { KingudActivationLockControl } from './kingud-activation-lock'
import type { KingudActivateTransaction } from './kingud-activation-transaction'
import {
  createKingudActivationTransaction,
  withKingudActivationCandidateReady,
  withKingudActivationIncumbentStopped,
  withKingudActivationSnapshot
} from './kingud-activation-transaction-transitions'
import { writeKingudActivationTransaction } from './kingud-activation-transaction-store'
import { execKingudRemoteOr, withoutAbortSignal } from './kingud-remote-runtime-control'
import { execKingudStateMutationOr } from './kingud-state-mutation-exec'
import {
  initialKingudActivationAdmissionCommand,
  parseInitialKingudActivationAdmission
} from './kingud-initial-activation-admission'
import {
  kingudSlotDir,
  resolveKingudSlotIdentity,
  type KingudSlotIdentity
} from './kingud-recovery-slot'
import { kingudSnapshotPath } from './kingud-incumbent-recovery'
import {
  restartAfterSnapshotFailure,
  restoreAfterRejectedCandidate,
  stopTransactionIncumbent
} from './kingud-transaction-incumbent'
import { withKingudLogTail } from './kingud-remote-log-tail'
import { kingudCandidateLaunchFailureCode } from '../kingud/kingud-host-unavailable'
import { errorMessage } from '../../shared/error-message'

type Outcome = Extract<KingudDeployResult, { outcome: 'installed-not-activated' }>

/** The caller's `admitRecord` refused the record found under the fence; nothing was touched. */
export const KINGUD_ACTIVATION_POLICY_REFUSED_CODE = 'kingud_activation_policy_refused'

const UNVERIFIABLE_CENSUS: KingudTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
}

function countedLockedRecord(
  options: KingudDeployOptions,
  record: KingudActivationRecord
): boolean {
  const counted = options.censusRecord
  return (
    !counted || (counted.active === record.active && counted.activatedAt === record.activatedAt)
  )
}

/** A census counted against another incumbent says nothing about this one's terminals. */
function censusForLockedRecord(
  options: KingudDeployOptions,
  record: KingudActivationRecord
): KingudTerminalCensus {
  return countedLockedRecord(options, record) ? options.census : UNVERIFIABLE_CENSUS
}

export async function activateInstalledKingud(
  options: KingudDeployOptions & { localKingudDir: string },
  fullVersion: string,
  remoteDir: string,
  lock: KingudActivationLockControl
): Promise<KingudDeployResult> {
  const now = options.now ?? ((): Date => new Date())
  const notActivated = (code: string, reason: string): Outcome => ({
    outcome: 'installed-not-activated',
    fullVersion,
    code,
    reason
  })
  const record = await readKingudActivationRecord(options)
  const plan = planKingudUpdate({
    record,
    candidateVersion: fullVersion,
    census: censusForLockedRecord(options, record),
    candidateDaemonProtocol: CURRENT_KINGUD_DAEMON_PROTOCOL,
    ...(options.force !== undefined ? { force: options.force } : {})
  })
  if (plan.action === 'noop') {
    return { outcome: 'already-active', fullVersion }
  }
  const refusal = options.admitRecord?.(record, fullVersion)
  if (refusal) {
    return notActivated(KINGUD_ACTIVATION_POLICY_REFUSED_CODE, refusal)
  }
  if (plan.action === 'defer') {
    return notActivated(plan.code, plan.reason)
  }

  try {
    await preflightInstalledKingud({
      ...options,
      remoteInstallDir: remoteDir,
      fullVersion
    })
  } catch (error) {
    options.signal?.throwIfAborted()
    return notActivated(
      'kingud_candidate_preflight_failed',
      `Candidate profile preflight failed; the incumbent was not stopped: ${errorMessage(error)}`
    )
  }

  let incumbent: KingudSlotIdentity | null = null
  if (record.active) {
    try {
      incumbent = await resolveKingudSlotIdentity(options, record.active)
    } catch (error) {
      if (isUnconfirmedSshCommandTermination(error)) {
        throw error
      }
      return notActivated(
        'kingud_incumbent_identity_unverifiable',
        `The active kingud ${record.active} build identity could not be verified before ` +
          `stopping it: ${errorMessage(error)} Nothing was stopped.`
      )
    }
  } else {
    const admission = parseInitialKingudActivationAdmission(
      await execKingudRemoteOr(
        options,
        initialKingudActivationAdmissionCommand(
          options.host,
          options.userDataDir,
          remoteDir,
          options.nodePath
        )
      )
    )
    if (admission.decision === 'defer') {
      return notActivated(admission.code, admission.reason)
    }
  }

  // Last check before anything stops: the census above may predate a long upload.
  if (incumbent && options.recountCensus && countedLockedRecord(options, record)) {
    const recount = planKingudUpdate({
      record,
      candidateVersion: fullVersion,
      census: await options.recountCensus(),
      candidateDaemonProtocol: CURRENT_KINGUD_DAEMON_PROTOCOL,
      ...(options.force !== undefined ? { force: options.force } : {})
    })
    if (recount.action === 'defer') {
      return notActivated(recount.code, recount.reason)
    }
  }

  const startedAt = now()
  let transaction: KingudActivateTransaction = createKingudActivationTransaction({
    transactionId: randomUUID(),
    candidateVersion: fullVersion,
    appVersion: options.appVersion,
    recordBefore: record,
    snapshotDirName: kingudSnapshotDirName(fullVersion, startedAt.getTime()),
    now: startedAt
  })
  await writeKingudActivationTransaction(options, transaction)
  lock.retainOnError()
  // Past the first mutation a cancel would strand a stopped host, so the run finishes or rolls back.
  options = withoutAbortSignal(options)

  const unstopped = incumbent ? await stopTransactionIncumbent(options, incumbent, lock) : null
  if (unstopped) {
    return notActivated(
      'kingud_outgoing_stop_incomplete',
      `${unstopped} No snapshot was taken and the candidate was not started. Kingu requires ` +
        'matching runtime readiness before signaling an incumbent and confirmed exit before ' +
        'snapshotting.'
    )
  }
  transaction = withKingudActivationIncumbentStopped(transaction, now())
  await writeKingudActivationTransaction(options, transaction)

  // A live SQLite WAL is not a backup boundary, so the snapshot waits for confirmed exit.
  const snapshotDir = kingudSnapshotPath(options, transaction.snapshot.dirName)
  const capture = parseKingudSnapshotCapture(
    await execKingudStateMutationOr(
      options,
      captureKingudStateSnapshotCommand(
        options.host,
        options.userDataDir,
        snapshotDir,
        kingudRemoteBaseDir(options.host, options.remoteHome)
      ),
      'FAILED'
    )
  )
  if (capture === 'failed') {
    const restarted = incumbent
      ? ` The incumbent was stopped before snapshotting; ${await restartAfterSnapshotFailure(options, incumbent, lock)}`
      : ''
    throw new Error(
      `Could not snapshot ${options.userDataDir} before activating ${fullVersion}. Kingu's ` +
        'persisted state carries no schema version, so without a snapshot a rollback has no ' +
        `way back. Refusing to activate.${restarted}`
    )
  }
  const snapshot: KingudStateSnapshot | null =
    capture === 'captured'
      ? {
          dirName: transaction.snapshot.dirName,
          takenBeforeVersion: fullVersion,
          readableByVersion: record.active,
          takenAt: startedAt.toISOString()
        }
      : null
  transaction = withKingudActivationSnapshot(transaction, capture, now())
  await writeKingudActivationTransaction(options, transaction)

  const { verdict, launchError } = await launchAndJudgeKingudSlot(options, {
    remoteInstallDir: remoteDir,
    fullVersion,
    buildHash: computeLocalKingudBuildHash(options.localKingudDir)
  })
  if (verdict.decision === 'reject') {
    const [code, reason] =
      launchError === undefined
        ? [verdict.code, verdict.reason]
        : [
            kingudCandidateLaunchFailureCode(launchError),
            `The candidate failed while starting: ${errorMessage(launchError)}`
          ]
    const restored = await restoreAfterRejectedCandidate(options, lock, {
      launchedDir: kingudSlotDir(options, transaction.candidateVersion),
      launchedVersion: transaction.candidateVersion,
      transactionStartedAt: transaction.startedAt,
      incumbent,
      restoreState: transaction.snapshot
    })
    const located =
      `${reason} Candidate stderr is at ` +
      `${joinRemotePath(options.host, remoteDir, KINGUD_LOG_FILENAME)}. ${restored}`
    return notActivated(code, await withKingudLogTail(options, remoteDir, located))
  }

  const recordAfter = withActivatedVersion(record, fullVersion, snapshot, now(), options.appVersion)
  transaction = withKingudActivationCandidateReady(transaction, recordAfter, now())
  await writeKingudActivationTransaction(options, transaction)
  await writeKingudActivationRecord(options, recordAfter)
  return { outcome: 'installed-and-activated', fullVersion, verdict }
}
