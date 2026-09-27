/**
 * Activate installed bytes only after the candidate proves healthy. A rejected candidate
 * allows restarting the incumbent only when profile state is provably unchanged; otherwise
 * preserve current state and the prelaunch snapshot for explicit recovery.
 */
import type { SshConnection } from './ssh-connection'
import { KINGUD_STARTUP_READINESS_TIMEOUT_MS } from '../../shared/kingud-profile-preflight'
import { execCommand } from './ssh-relay-deploy-helpers'
import { KINGUD_INSTALL_MODEL } from './remote-install-model'
import { writeRelayFile } from './ssh-relay-install-transfers'
import { computeRemoteInstallDir, readLocalFullVersion } from './ssh-relay-versioned-install'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import {
  KINGUD_STATE_SNAPSHOT_DIR,
  serializeKingudActivationRecord,
  withActivatedVersion,
  type KingudActivationRecord,
  type KingudStateSnapshot
} from './kingud-activation-record'
import { kingudActivationPath, readKingudActivationRecord } from './kingud-activation-record-store'
import { evaluateKingudActivation, type KingudActivationVerdict } from './kingud-activation-gate'
import { planKingudUpdate, type KingudTerminalCensus } from './kingud-update-plan'
import {
  KINGUD_LOG_FILENAME,
  kingudLaunchCommand,
  parseKingudReadinessOutput,
  readKingudReadinessCommand
} from './kingud-remote-launch'
import { rejectedKingudStateRecoveryRefusal, stopOutgoingKingud } from './kingud-remote-deploy-stop'
import {
  captureKingudStateSnapshotCommand,
  kingudSnapshotDirName,
  parseKingudSnapshotCapture
} from './kingud-state-snapshot'
import {
  kingudStopFreedTheHost,
  parseKingudStopOutcome,
  stopKingudCommand
} from './kingud-remote-process-control'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { computeLocalKingudBuildHash } from './kingud-local-build-hash'
import { preflightInstalledKingud } from './kingud-remote-preflight'
import { assertPosixKingudHost } from './kingud-remote-host-support'
import { installKingudBundle } from './kingud-remote-install'
import { materializeKingudArtifact } from './kingud-artifact-materializer'
import { resolveKingudDeploymentTarget } from './kingud-deployment-target'

export type KingudDeployOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  /** An already assembled bundle; otherwise materialize the packaged template for this host. */
  localKingudDir?: string
  nodePath: string
  userDataDir: string
  bindHost: string
  port: number
  /**
   * Live-terminal counts, supplied by the caller from the runtime it is already connected
   * to. Not probed here: counting the daemon's sessions needs its protocol, and a deploy
   * that guessed zero from silence would be the "loss of contact means death" mistake.
   */
  census: KingudTerminalCensus
  force?: boolean
  readinessTimeoutMs?: number
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

export type KingudDeployResult =
  | { outcome: 'installed-and-activated'; fullVersion: string; verdict: KingudActivationVerdict }
  | { outcome: 'already-active'; fullVersion: string }
  | { outcome: 'installed-not-activated'; fullVersion: string; code: string; reason: string }

const READINESS_POLL_MS = 500
const STOP_WAIT_SECONDS = 20

function exec(options: KingudDeployOptions, command: string): Promise<string> {
  return execCommand(options.conn, command, {
    wrapCommand: options.host.commandDialect !== 'powershell',
    signal: options.signal
  })
}

function baseDir(options: KingudDeployOptions): string {
  return joinRemotePath(options.host, options.remoteHome, RELAY_REMOTE_DIR)
}

async function captureSnapshot(
  options: KingudDeployOptions,
  fullVersion: string,
  outgoingVersion: string | null,
  takenAt: Date
): Promise<KingudStateSnapshot | null> {
  // The caller has already stopped the outgoing runtime. This is required once profile state
  // includes SQLite: a tar of a live WAL, main database, and SHM file is not a SQLite backup.
  const dirName = kingudSnapshotDirName(fullVersion, takenAt.getTime())
  const snapshotDir = joinRemotePath(
    options.host,
    baseDir(options),
    KINGUD_STATE_SNAPSHOT_DIR,
    dirName
  )
  const capture = parseKingudSnapshotCapture(
    await exec(
      options,
      captureKingudStateSnapshotCommand(options.host, options.userDataDir, snapshotDir)
    )
  )
  if (capture === 'failed') {
    throw new Error(
      `Could not snapshot ${options.userDataDir} before activating ${fullVersion}. Kingu's ` +
        'persisted state carries no schema version, so without a snapshot a rollback has no ' +
        'way back. Refusing to activate.'
    )
  }
  // Empty profiles need no rollback snapshot.
  if (capture === 'empty') {
    return null
  }
  return {
    dirName,
    takenBeforeVersion: fullVersion,
    readableByVersion: outgoingVersion,
    takenAt: takenAt.toISOString()
  }
}

async function launchAndAwaitReadiness(
  options: KingudDeployOptions,
  remoteInstallDir: string,
  fullVersion: string
): Promise<ReturnType<typeof parseKingudReadinessOutput>> {
  await exec(
    options,
    kingudLaunchCommand(options.host, { ...options, remoteInstallDir, fullVersion })
  )
  const deadline = Date.now() + (options.readinessTimeoutMs ?? KINGUD_STARTUP_READINESS_TIMEOUT_MS)
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let last = parseKingudReadinessOutput('')
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted()
    last = parseKingudReadinessOutput(
      await exec(options, readKingudReadinessCommand(options.host, remoteInstallDir))
    )
    if (last.state !== 'pending') {
      return last
    }
    await sleep(READINESS_POLL_MS)
  }
  return last
}

/** Restart the incumbent only when the candidate left shared state unchanged. */
async function restoreIncumbent(
  options: KingudDeployOptions,
  record: KingudActivationRecord,
  candidateDir?: string,
  snapshot?: KingudStateSnapshot | null
): Promise<string> {
  if (candidateDir) {
    const stopped = parseKingudStopOutcome(
      await exec(
        options,
        stopKingudCommand(options.host, candidateDir, {
          waitSeconds: STOP_WAIT_SECONDS,
          justLaunched: true
        })
      )
    )
    if (!kingudStopFreedTheHost(stopped)) {
      return `The candidate itself did not stop (${stopped}); the host may still be serving the rejected build.`
    }
  }
  if (!record.active) {
    return 'No previous version was active, so this host is now serving nothing.'
  }
  if (candidateDir) {
    const snapshotDir = snapshot
      ? joinRemotePath(options.host, baseDir(options), KINGUD_STATE_SNAPSHOT_DIR, snapshot.dirName)
      : undefined
    const refusal = await rejectedKingudStateRecoveryRefusal(options, record.active, snapshotDir)
    if (refusal) {
      return refusal
    }
  }
  const incumbentDir = computeRemoteInstallDir(
    KINGUD_INSTALL_MODEL,
    options.remoteHome,
    record.active
  )
  const parsed = await launchAndAwaitReadiness(options, incumbentDir, record.active)
  return parsed.state === 'ready'
    ? `kingud ${record.active} was restarted and is serving again.`
    : `kingud ${record.active} was relaunched but has not published readiness; this host may be down.`
}

/** Activate on a healthy verdict; retain changed candidate state for explicit recovery. */
export async function deployKingud(input: KingudDeployOptions): Promise<KingudDeployResult> {
  assertPosixKingudHost(input.host)
  const options = {
    ...input,
    localKingudDir:
      input.localKingudDir ??
      (await materializeKingudArtifact(await resolveKingudDeploymentTarget(input), {
        signal: input.signal
      }))
  }
  const now = options.now ?? ((): Date => new Date())
  const fullVersion = readLocalFullVersion(options.localKingudDir)
  const remoteDir = computeRemoteInstallDir(KINGUD_INSTALL_MODEL, options.remoteHome, fullVersion)
  const record = await readKingudActivationRecord(options)

  await installKingudBundle(options, fullVersion, remoteDir)

  const plan = planKingudUpdate({
    record,
    candidateVersion: fullVersion,
    census: options.census,
    ...(options.force !== undefined ? { force: options.force } : {})
  })
  if (plan.action === 'noop') {
    return { outcome: 'already-active', fullVersion }
  }
  if (plan.action === 'defer') {
    return {
      outcome: 'installed-not-activated',
      fullVersion,
      code: plan.code,
      reason: plan.reason
    }
  }

  try {
    await preflightInstalledKingud({
      ...options,
      remoteInstallDir: remoteDir,
      fullVersion
    })
  } catch (error) {
    options.signal?.throwIfAborted()
    return {
      outcome: 'installed-not-activated',
      fullVersion,
      code: 'kingud_candidate_preflight_failed',
      reason: `Candidate profile preflight failed; the incumbent was not stopped: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }

  if (record.active) {
    const stopped = await stopOutgoingKingud(options, record.active)
    if (!kingudStopFreedTheHost(stopped)) {
      return {
        outcome: 'installed-not-activated',
        fullVersion,
        code: 'kingud_outgoing_stop_incomplete',
        reason:
          `Could not verify that kingud ${record.active} exited (${stopped}). ` +
          'No snapshot was taken and the candidate was not started. Kingu requires matching ' +
          'runtime readiness before signaling an incumbent and confirmed exit before snapshotting.'
      }
    }
  }

  // A live SQLite WAL is not a backup boundary: tar can observe the main file, WAL and SHM
  // at different points and restore a set SQLite cannot recover. Stop the incumbent first so
  // its final durable flush has completed before capturing the pre-activation state.
  let snapshot: KingudStateSnapshot | null = null
  if (record.active) {
    try {
      snapshot = await captureSnapshot(options, fullVersion, record.active, now())
    } catch (error) {
      const restored = await restoreIncumbent(options, record).catch(
        (restartError: unknown) =>
          `The incumbent could not be restarted: ${
            restartError instanceof Error ? restartError.message : String(restartError)
          }`
      )
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} The incumbent was stopped ` +
          `before snapshotting; ${restored}`
      )
    }
  }

  const parsed = await launchAndAwaitReadiness(options, remoteDir, fullVersion)
  const verdict = evaluateKingudActivation(parsed.state === 'ready' ? parsed.readiness : null, {
    buildHash: computeLocalKingudBuildHash(options.localKingudDir),
    fullVersion
  })
  if (verdict.decision === 'reject') {
    const restored = await restoreIncumbent(options, record, remoteDir, snapshot)
    return {
      outcome: 'installed-not-activated',
      fullVersion,
      code: verdict.code,
      reason:
        `${verdict.reason} Candidate stderr is at ` +
        `${joinRemotePath(options.host, remoteDir, KINGUD_LOG_FILENAME)}. ${restored}`
    }
  }

  await writeRelayFile(
    options.conn,
    options.host,
    kingudActivationPath(options.host, options.remoteHome),
    serializeKingudActivationRecord(withActivatedVersion(record, fullVersion, snapshot, now())),
    { signal: options.signal }
  )
  return { outcome: 'installed-and-activated', fullVersion, verdict }
}
