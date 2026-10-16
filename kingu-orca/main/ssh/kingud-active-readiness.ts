/** Proving that the kingud an activation record names is the one actually serving. */
import {
  evaluateKingudActivation,
  type KingudActivationExpectation
} from './kingud-activation-gate'
import {
  kingudLivenessProbeCommand,
  parseKingudLiveness,
  type KingudLaunchSpec,
  type KingudReadinessParse
} from './kingud-remote-launch'
import {
  execKingudRemote,
  launchKingudAndAwaitReadiness,
  type KingudRemoteExecTarget
} from './kingud-remote-runtime-control'
import {
  parseKingudReadinessWaitOutput,
  readKingudReadinessNowCommand
} from './kingud-remote-readiness-wait'
import type { ServeReadiness } from '../server/serve-readiness'
import { withKingudLogTail } from './kingud-remote-log-tail'

/** `exited` is proven absence; `unverifiable` means the host could not say, which is not death. */
export type KingudReadinessFailureVerdict = 'exited' | 'unverifiable' | 'rejected'

export class KingudActiveReadinessError extends Error {
  constructor(
    readonly verdict: KingudReadinessFailureVerdict,
    message: string
  ) {
    super(message)
    this.name = 'KingudActiveReadinessError'
  }
}

function gatedReadiness(
  parsed: KingudReadinessParse,
  expectation: KingudActivationExpectation,
  label: string
): ServeReadiness {
  const readiness = parsed.state === 'ready' ? parsed.readiness : null
  const verdict = evaluateKingudActivation(readiness, expectation)
  if (verdict.decision === 'reject') {
    throw new KingudActiveReadinessError(
      'rejected',
      `${label} failed its readiness check: ${verdict.reason}`
    )
  }
  if (!readiness) {
    throw new KingudActiveReadinessError(
      'rejected',
      `${label} passed activation without a readiness payload.`
    )
  }
  const coverage = kingudDaemonCoverageRefusal(readiness)
  if (coverage) {
    throw new KingudActiveReadinessError('rejected', `${label} ${coverage}`)
  }
  return readiness
}

/**
 * A slot proves terminals only when its daemon's self-test spawned a PTY, or completed the
 * handshake on a platform whose daemon never spawn-probes. A build that predates the coverage
 * field keeps the identity gate alone, so an older slot is not stranded.
 */
export function kingudDaemonCoverageRefusal(readiness: ServeReadiness): string | null {
  const health = readiness.health
  const coverage = health?.terminalDaemon?.selfTest?.coverage
  if (!health || coverage === undefined || coverage === 'pty-spawn') {
    return null
  }
  if (coverage === 'handshake' && health.platform === 'win32') {
    return null
  }
  return (
    `reported terminal-daemon coverage '${String(coverage)}', which does not prove a PTY can ` +
    `be created on ${health.platform}.`
  )
}

/** Checks a recorded-active slot without starting anything. */
export async function probeActiveKingudReadiness(
  target: KingudRemoteExecTarget & { remoteInstallDir: string },
  expectation: KingudActivationExpectation
): Promise<ServeReadiness> {
  const liveness = parseKingudLiveness(
    await execKingudRemote(target, kingudLivenessProbeCommand(target.host, target.remoteInstallDir))
  )
  if (liveness === 'DEAD') {
    throw new KingudActiveReadinessError(
      'exited',
      `kingud ${expectation.fullVersion} is recorded active but its process has exited.`
    )
  }
  if (liveness !== 'LIVE') {
    throw new KingudActiveReadinessError(
      'unverifiable',
      `kingud ${expectation.fullVersion} process state is unverifiable.`
    )
  }
  const parsed = parseKingudReadinessWaitOutput(
    target.host,
    await execKingudRemote(
      target,
      readKingudReadinessNowCommand(target.host, target.remoteInstallDir)
    )
  )
  return gatedReadiness(parsed, expectation, 'The active kingud')
}

/** Starts a slot (recovery or rollback) and accepts it only if it proves the expected build. */
export async function launchKingudSlotAndAwaitReadiness(
  target: KingudRemoteExecTarget & {
    readinessTimeoutMs?: number
    sleep?: (ms: number) => Promise<void>
  },
  spec: KingudLaunchSpec,
  expectation: KingudActivationExpectation
): Promise<ServeReadiness> {
  const parsed = await launchKingudAndAwaitReadiness(target, spec)
  try {
    return gatedReadiness(parsed, expectation, `kingud ${spec.fullVersion}`)
  } catch (error) {
    if (!(error instanceof KingudActiveReadinessError)) {
      throw error
    }
    const message = await withKingudLogTail(target, spec.remoteInstallDir, error.message)
    throw new KingudActiveReadinessError(error.verdict, message)
  }
}
