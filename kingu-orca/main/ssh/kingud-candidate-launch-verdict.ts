import { evaluateKingudActivation, type KingudActivationVerdict } from './kingud-activation-gate'
import { kingudActivationTransactionRoot } from './kingud-activation-transaction'
import type { KingudReadinessParse } from './kingud-remote-launch'
import {
  launchKingudAndAwaitReadiness,
  type KingudRemoteExecTarget
} from './kingud-remote-runtime-control'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'

type CandidateLaunchTarget = Parameters<typeof launchKingudAndAwaitReadiness>[0] &
  KingudRemoteExecTarget & {
    remoteHome: string
    nodePath: string
    userDataDir: string
    bindHost: string
    port: number
  }

/**
 * Starts one slot and judges its readiness. An unconfirmed SSH termination rethrows: it says
 * nothing about the candidate, so it must never read as a rejected one.
 */
export async function launchAndJudgeKingudSlot(
  options: CandidateLaunchTarget,
  slot: { remoteInstallDir: string; fullVersion: string; buildHash: string }
): Promise<{ verdict: KingudActivationVerdict; launchError: unknown }> {
  let parsed: KingudReadinessParse | null = null
  let launchError: unknown
  try {
    parsed = await launchKingudAndAwaitReadiness(options, {
      remoteInstallDir: slot.remoteInstallDir,
      nodePath: options.nodePath,
      fullVersion: slot.fullVersion,
      userDataDir: options.userDataDir,
      bindHost: options.bindHost,
      port: options.port,
      activationRoot: kingudActivationTransactionRoot(options.host, options.remoteHome)
    })
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    launchError = error
  }
  const verdict = evaluateKingudActivation(parsed?.state === 'ready' ? parsed.readiness : null, {
    buildHash: slot.buildHash,
    fullVersion: slot.fullVersion
  })
  return { verdict, launchError }
}
