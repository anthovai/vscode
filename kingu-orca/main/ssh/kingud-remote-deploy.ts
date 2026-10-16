/**
 * Activate installed bytes only after the candidate proves healthy. A rejected candidate
 * allows restarting the incumbent only when profile state is provably unchanged; otherwise
 * preserve current state and the prelaunch snapshot for explicit recovery.
 *
 * Every activation runs under the host's activation fence and journal
 * (`kingud-activation-lock.ts`), so an interrupted one is recoverable to exactly one slot.
 */
import { logKingudActivationOutcome } from './kingud-activation-outcome-log'
import { join } from 'node:path'
import type { KingudHostTransport } from './kingud-host-transport'
import { KINGUD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir, readLocalFullVersion } from './remote-versioned-install'
import { readKingudActivationRecord } from './kingud-activation-record-store'
import type { KingudActivationRecord } from './kingud-activation-record'
import type { KingudActivationVerdict } from './kingud-activation-gate'
import type { KingudTerminalCensus } from './kingud-update-plan'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { installKingudBundle } from './kingud-remote-install'
import { getAppEnvironment } from '../../shared/app-environment'
import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { KINGUD_STARTUP_READINESS_TIMEOUT_MS } from '../../shared/kingud-profile-preflight'
import { materializeKingudArtifact } from '../kingud/kingud-artifact-materializer'
import { readKingudBundleTarget } from './kingud-deployment-target'
import { resolveKingudRuntimeTarget } from './kingud-runtime-target'
import { materializeNodeRuntimeArchive } from '../node-runtime/pinned-runtime-materializer'
import {
  kingudActivationFenceExists,
  resolveKingudActivationReadinessTimeout,
  withKingudActivationLock
} from './kingud-activation-lock'
import { activateInstalledKingud } from './kingud-installed-activation'
import { kingudActivationFenceRefusal } from './kingud-activation-fence-hold'

export type KingudDeployOptions = {
  conn: KingudHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  /** An already assembled bundle; otherwise materialize the packaged template for this host. */
  localKingudDir?: string
  /** The bundle's runtime target; read from `localKingudDir` or probed when absent. */
  target?: NodeRuntimeTarget
  /** Where the pinned runtime archive is cached; defaults beside the kingud artifact cache. */
  runtimeCacheRoot?: string
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
  /**
   * The record `census` was counted against; defaults to the one read before upload. A different
   * incumbent found under the fence makes the census unverifiable rather than wrongly zero.
   */
  censusRecord?: KingudActivationRecord
  /**
   * Counts again under the fence just before the incumbent stops, so a terminal opened during
   * the upload still defers the update. Called only while the incumbent is the one counted.
   */
  recountCensus?: () => Promise<KingudTerminalCensus>
  force?: boolean
  /** The Kingu app version activating, recorded so an older client never downgrades the host. */
  appVersion?: string
  /**
   * Re-applies the caller's version policy to the record read under the host fence, since another
   * desktop can activate or stop a build while this one uploads. A reason refuses the activation.
   */
  admitRecord?: (record: KingudActivationRecord, candidateVersion: string) => string | null
  readinessTimeoutMs?: number
  /** WSL only; SSH hosts always re-hash the runtime (see `installKingudBundle`). */
  recordedNodeRuntimeProbe?: boolean
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

export type KingudDeployResult =
  | { outcome: 'installed-and-activated'; fullVersion: string; verdict: KingudActivationVerdict }
  | { outcome: 'already-active'; fullVersion: string }
  | { outcome: 'installed-not-activated'; fullVersion: string; code: string; reason: string }

/** Activate on a healthy verdict; retain changed candidate state for explicit recovery. */
export async function deployKingud(
  input: KingudDeployOptions,
  retryClearedFence = true
): Promise<KingudDeployResult> {
  const target =
    input.target ??
    (input.localKingudDir
      ? readKingudBundleTarget(input.localKingudDir)
      : await resolveKingudRuntimeTarget(input))
  const options = {
    ...input,
    target,
    readinessTimeoutMs: resolveKingudActivationReadinessTimeout(
      input.readinessTimeoutMs,
      KINGUD_STARTUP_READINESS_TIMEOUT_MS
    ),
    nodeRuntimeArchive: () =>
      materializeNodeRuntimeArchive(
        target,
        input.runtimeCacheRoot ?? join(getAppEnvironment().getPath('userData'), 'kingud-artifacts'),
        { signal: input.signal }
      ),
    localKingudDir:
      input.localKingudDir ?? (await materializeKingudArtifact(target, { signal: input.signal }))
  }
  const fullVersion = readLocalFullVersion(options.localKingudDir)
  const remoteDir = computeRemoteInstallDir(KINGUD_INSTALL_MODEL, options.remoteHome, fullVersion)
  const held = async (): Promise<KingudDeployResult> => {
    const { cleared, ...refusal } = await kingudActivationFenceRefusal(options, 'update')
    // Once: a second abandoned fence means something keeps leaving them, so report it.
    if (cleared && retryClearedFence) {
      return deployKingud({ ...input, target, localKingudDir: options.localKingudDir }, false)
    }
    return { outcome: 'installed-not-activated', fullVersion, ...refusal }
  }
  // Fail fast before upload; the activation re-reads both under the fence.
  const preUploadRecord = await readKingudActivationRecord(options)
  const censusRecord = options.censusRecord ?? preUploadRecord
  // An unanswered probe only skips this shortcut: the fence acquisition itself still decides.
  if (await kingudActivationFenceExists(options).catch(() => false)) {
    return held()
  }

  await installKingudBundle(options, fullVersion, remoteDir)

  return logKingudActivationOutcome(
    `update to ${fullVersion}`,
    () =>
      withKingudActivationLock(
        options,
        (lock) =>
          activateInstalledKingud({ ...options, censusRecord }, fullVersion, remoteDir, lock),
        held
      ),
    ['installed-and-activated', 'already-active']
  )
}
