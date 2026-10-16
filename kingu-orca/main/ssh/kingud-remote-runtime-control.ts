/** Launch a slot and wait for its readiness: the one loop deploy, rollback and recovery share. */
import { KINGUD_STARTUP_READINESS_TIMEOUT_MS } from '../../shared/kingud-profile-preflight'
import {
  kingudLaunchCommand,
  parseKingudReadinessOutput,
  type KingudLaunchSpec,
  type KingudReadinessParse
} from './kingud-remote-launch'
import {
  readWindowsKingudLaunchReport,
  readWindowsKingudSlotRuntime,
  readWindowsKingudSlotEntry,
  windowsKingudLaunchCommand,
  windowsKingudLaunchRuntimeCommand
} from './kingud-remote-launch-windows'
import {
  KINGUD_READINESS_WAIT_MAX_SECONDS,
  kingudReadinessWaitCommand,
  parseKingudReadinessWaitOutput
} from './kingud-remote-readiness-wait'
import type { KingudHostTransport } from './kingud-host-transport'
import { errorMessage } from '../../shared/error-message'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import {
  currentKingudFence,
  isKingudFenceLost,
  KingudFenceLostError,
  posixKingudFenceGuard
} from './kingud-activation-fence-scope'
import { kingudWindowsHomeOpCommand } from './kingud-remote-windows-node'
import { KINGUD_WINDOWS_FENCE_ARG } from './kingud-windows-host-fence-ops'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

// Only between host-side waits, so a host that answers early cannot turn this into a tight loop.
const READINESS_RETRY_PAUSE_MS = 1_000

export type KingudRemoteExecTarget = {
  conn: KingudHostTransport
  host: RemoteHostPlatform
  signal?: AbortSignal
  /** Locates the runtime store for host-record scripts; required on Windows, unused elsewhere. */
  remoteHome?: string
}

/** Under a held activation fence, the step runs only while the host still names this run its owner. */
export async function execKingudRemote(
  target: KingudRemoteExecTarget,
  command: string,
  signal = target.signal
): Promise<string> {
  const fence = currentKingudFence()
  const run = (line: string): Promise<string> =>
    execCommand(target.conn, line, {
      wrapCommand: target.host.commandDialect !== 'powershell',
      signal
    })
  try {
    if (!fence) {
      return await run(command)
    }
    if (!isWindowsRemoteHost(target.host)) {
      return await run(`${posixKingudFenceGuard(fence)} ${command}`)
    }
    // A host op checks inside the host script; anything else is checked by one op just before it.
    if (!command.includes(KINGUD_WINDOWS_FENCE_ARG) && target.remoteHome) {
      await run(kingudWindowsHomeOpCommand(target.host, target.remoteHome, 'fence-check', []))
    }
    return await run(command)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    throw isKingudFenceLost(error) ? new KingudFenceLostError() : error
  }
}

/** A confirmed failure reads as `fallback`; an unconfirmed one or a lost fence propagates. */
export function execKingudRemoteOr(
  target: KingudRemoteExecTarget,
  command: string,
  fallback = ''
): Promise<string> {
  return execKingudRemote(target, command).catch((error: unknown) => {
    if (isUnconfirmedSshCommandTermination(error) || error instanceof KingudFenceLostError) {
      throw error
    }
    return fallback
  })
}

/** Recovery paths must finish even when the request that started them was cancelled. */
export function withoutAbortSignal<T extends { signal?: AbortSignal }>(
  options: T
): Omit<T, 'signal'> {
  const { signal: _signal, ...rest } = options
  return rest
}

export async function launchKingudAndAwaitReadiness(
  target: KingudRemoteExecTarget & {
    readinessTimeoutMs?: number
    sleep?: (ms: number) => Promise<void>
  },
  spec: KingudLaunchSpec
): Promise<KingudReadinessParse> {
  if (isWindowsRemoteHost(target.host)) {
    const slotAnswer = await execKingudRemote(
      target,
      windowsKingudLaunchRuntimeCommand(target.host, spec.remoteInstallDir)
    )
    const slotRuntime = readWindowsKingudSlotRuntime(slotAnswer)
    const slotEntry = readWindowsKingudSlotEntry(slotAnswer, target.host, spec.remoteInstallDir)
    readWindowsKingudLaunchReport(
      await execKingudRemote(
        target,
        windowsKingudLaunchCommand(target.host, spec, slotRuntime, slotEntry)
      )
    )
  } else {
    await execKingudRemote(
      target,
      kingudLaunchCommand(
        target.host,
        spec,
        target.conn.kingudLaunchDetach ?? 'nohup',
        (await target.conn.kingudLaunchEnv?.()) ?? []
      )
    )
  }
  const deadline = Date.now() + (target.readinessTimeoutMs ?? KINGUD_STARTUP_READINESS_TIMEOUT_MS)
  const sleep = target.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let last = parseKingudReadinessOutput('')
  let lastWaitError: unknown
  // At least one read: a client descheduled past a short deadline must not fail a ready launch.
  for (let first = true; first || Date.now() < deadline; first = false) {
    target.signal?.throwIfAborted()
    const waitSeconds = Math.min(
      KINGUD_READINESS_WAIT_MAX_SECONDS,
      Math.ceil((deadline - Date.now()) / 1000)
    )
    let output: string
    try {
      output = await execKingudRemote(
        target,
        kingudReadinessWaitCommand(target.host, spec.remoteInstallDir, waitSeconds)
      )
    } catch (error) {
      if (
        (error instanceof Error && error.name === 'AbortError') ||
        isUnconfirmedSshCommandTermination(error) ||
        error instanceof KingudFenceLostError
      ) {
        throw error
      }
      // Why retry: a failed read (a refused channel, a timed-out wait) says nothing about the
      // launched process. Failing the launch here makes the caller stop a healthy candidate.
      lastWaitError = error
      console.warn(`[kingud] readiness wait failed; retrying: ${errorMessage(error)}`)
      await sleep(READINESS_RETRY_PAUSE_MS)
      continue
    }
    target.signal?.throwIfAborted()
    lastWaitError = undefined
    last = parseKingudReadinessWaitOutput(target.host, output)
    if (last.state !== 'pending') {
      return last
    }
    await sleep(READINESS_RETRY_PAUSE_MS)
  }
  if (lastWaitError !== undefined) {
    throw lastWaitError
  }
  return last
}
