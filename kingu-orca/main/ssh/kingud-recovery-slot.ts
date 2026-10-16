/**
 * Slot-level verdicts shared by activation, rollback and their crash recovery.
 *
 * Every verdict here is the execution host's: `exited` only on positive proof, and a probe
 * that could not answer is `unverifiable` — never a reason to start a second slot.
 */
import type { ServeReadiness } from '../server/serve-readiness'
import type { KingudActivationExpectation } from './kingud-activation-gate'
import { KINGUD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir } from './remote-versioned-install'
import { readRemoteKingudBuildHash } from './kingud-remote-build-hash'
import {
  launchKingudSlotAndAwaitReadiness,
  KingudActiveReadinessError,
  probeActiveKingudReadiness
} from './kingud-active-readiness'
import { kingudLivenessProbeCommand, parseKingudLiveness } from './kingud-remote-launch'
import {
  parseKingudStopOutcome,
  stopKingudCommand,
  type KingudStopOutcome
} from './kingud-remote-process-control'
import { execKingudRemote, type KingudRemoteExecTarget } from './kingud-remote-runtime-control'
import { kingudActivationTransactionRoot } from './kingud-activation-transaction'
import {
  initialKingudActivationAdmissionCommand,
  parseInitialKingudActivationAdmission
} from './kingud-initial-activation-admission'

export const KINGUD_SLOT_STOP_WAIT_SECONDS = 20

export type KingudSlotOptions = KingudRemoteExecTarget & {
  remoteHome: string
  /** Host Node for legacy slots only; a slot's own runtime marker wins. */
  nodePath: string
  userDataDir: string
  bindHost: string
  port: number
  readinessTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

export type KingudSlotIdentity = { version: string; remoteDir: string; buildHash: string }

function expectation(identity: KingudSlotIdentity): KingudActivationExpectation {
  return { buildHash: identity.buildHash, fullVersion: identity.version }
}

export function kingudSlotDir(options: KingudSlotOptions, version: string): string {
  return computeRemoteInstallDir(KINGUD_INSTALL_MODEL, options.remoteHome, version)
}

/** Reads the installed bytes' hash, so a later readiness payload can be matched to them. */
export async function resolveKingudSlotIdentity(
  options: KingudSlotOptions,
  version: string
): Promise<KingudSlotIdentity> {
  const remoteDir = kingudSlotDir(options, version)
  return { version, remoteDir, buildHash: await readRemoteKingudBuildHash(options, remoteDir) }
}

export function launchKingudSlot(
  options: KingudSlotOptions,
  identity: KingudSlotIdentity
): Promise<ServeReadiness> {
  return launchKingudSlotAndAwaitReadiness(
    options,
    {
      remoteInstallDir: identity.remoteDir,
      nodePath: options.nodePath,
      fullVersion: identity.version,
      userDataDir: options.userDataDir,
      bindHost: options.bindHost,
      port: options.port,
      // Every SSH launch is client-managed, so every one may idle out and be woken on connect.
      activationRoot: kingudActivationTransactionRoot(options.host, options.remoteHome)
    },
    expectation(identity)
  )
}

/** Proves the slot serves, starting it only on proven exit. */
export async function ensureKingudSlotServing(
  options: KingudSlotOptions,
  identity: KingudSlotIdentity
): Promise<ServeReadiness> {
  const liveness = parseKingudLiveness(
    await execKingudRemote(options, kingudLivenessProbeCommand(options.host, identity.remoteDir))
  )
  if (liveness === 'LIVE') {
    return probeActiveKingudReadiness(
      { ...options, remoteInstallDir: identity.remoteDir },
      expectation(identity)
    )
  }
  if (liveness === 'UNKNOWN') {
    throw new KingudActiveReadinessError(
      'unverifiable',
      `kingud ${identity.version} process state is unverifiable.`
    )
  }
  return launchKingudSlot(options, identity)
}

/** `justLaunched` only for a slot this run started; otherwise the readiness PID must agree. */
export async function stopKingudSlot(
  options: KingudSlotOptions,
  remoteDir: string,
  justLaunched: boolean
): Promise<KingudStopOutcome> {
  return parseKingudStopOutcome(
    await execKingudRemote(
      options,
      stopKingudCommand(
        options.host,
        remoteDir,
        justLaunched
          ? { waitSeconds: KINGUD_SLOT_STOP_WAIT_SECONDS, justLaunched: true }
          : { waitSeconds: KINGUD_SLOT_STOP_WAIT_SECONDS, nodePath: options.nodePath }
      )
    )
  )
}

export type KingudSlotQuiescence = 'exited' | 'other-slot-serving'

/**
 * Before an interrupted run's state is replaced: the slot it started must be proven exited and
 * the slot being restored must not be running, or must already be serving (nothing to undo).
 *
 * A missing PID file is not proof of exit: an SSH drop can kill the launcher after `nohup`
 * but before it records `$!`, so the data root's owner records decide.
 */
export async function quiesceInterruptedKingudSlot(
  options: KingudSlotOptions,
  /** `null` when nothing was launched, so only `otherSlot` needs ruling out. */
  version: string | null,
  otherSlot: KingudSlotIdentity | null
): Promise<KingudSlotQuiescence> {
  const remoteDir = version === null ? null : kingudSlotDir(options, version)
  const stopped =
    remoteDir === null ? 'already-exited' : await stopKingudSlot(options, remoteDir, false)
  let exited = stopped === 'stopped' || stopped === 'already-exited'
  if ((stopped === 'unknown' || stopped === 'unconfirmed') && remoteDir !== null) {
    // No verified answer, e.g. the slot died before readiness; liveness decides.
    exited = (await slotLiveness(options, remoteDir)) === 'DEAD'
  }
  if (otherSlot) {
    const other = await slotLiveness(options, otherSlot.remoteDir)
    if (other === 'LIVE' && (exited || stopped === 'no-pid')) {
      // The serving slot holds the instance lock, so a PID-less launch cannot own the state.
      await probeActiveKingudReadiness(
        { ...options, remoteInstallDir: otherSlot.remoteDir },
        expectation(otherSlot)
      )
      return 'other-slot-serving'
    }
    if (other !== 'DEAD') {
      throw new KingudActiveReadinessError(
        'unverifiable',
        `kingud ${version ?? 'candidate'} (${stopped}) and ${otherSlot.version} (${other}) cannot both be ` +
          'ruled out as owners of the shared state; it was not replaced.'
      )
    }
  }
  if (!exited && stopped === 'no-pid' && remoteDir !== null) {
    const admission = parseInitialKingudActivationAdmission(
      await execKingudRemote(
        options,
        initialKingudActivationAdmissionCommand(
          options.host,
          options.userDataDir,
          remoteDir,
          options.nodePath
        )
      )
    )
    exited = admission.decision === 'proceed'
  }
  if (!exited) {
    throw new KingudActiveReadinessError(
      'unverifiable',
      `kingud ${version ?? 'candidate'} could not be confirmed stopped (${stopped}); replacing its state would be unsafe.`
    )
  }
  return 'exited'
}

export async function slotLiveness(
  options: KingudSlotOptions,
  remoteDir: string
): Promise<'LIVE' | 'DEAD' | 'UNKNOWN'> {
  return parseKingudLiveness(
    await execKingudRemote(options, kingudLivenessProbeCommand(options.host, remoteDir))
  )
}
