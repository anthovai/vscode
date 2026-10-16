/**
 * Starting a candidate kingud on a Windows SSH host.
 *
 * Win32-OpenSSH kills the session's job when the session ends, so kingud must leave that job.
 * The server entry's `--windows-breakaway-launch` mode does it the way the relay does: one CreateProcessW with
 * CREATE_BREAKAWAY_FROM_JOB through the slot's staged process-tree addon. Unlike the relay there
 * is no WMI fallback: Win32_Process.Create is EDR-scored remote execution and refused to a
 * standard user's network logon, so a host that cannot break away refuses the launch.
 *
 * Two execs, neither through PowerShell: the host script resolves the runtime the slot's marker
 * names (and drops a stale stop request), then that node.exe runs the launcher with plain argv.
 * The launcher records the PID with its creation time; a PID alone is not an identity on Windows.
 */
import {
  KINGUD_WINDOWS_BREAKAWAY_CONTRACT,
  parseWindowsBreakawayLaunchReport,
  WINDOWS_BREAKAWAY_ENV_FLAG,
  WINDOWS_BREAKAWAY_LAUNCH_FLAG,
  WINDOWS_BREAKAWAY_PROCESS_FILE_FLAG,
  WINDOWS_BREAKAWAY_STDERR_FLAG,
  WINDOWS_BREAKAWAY_STDERR_KEEP_PREVIOUS_FLAG,
  WINDOWS_BREAKAWAY_STDOUT_FLAG
} from '../../shared/windows-breakaway-launch'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  kingudWindowsNodeCommandLine,
  kingudWindowsSlotOpCommand,
  readKingudWindowsEncodedAnswer
} from './kingud-remote-windows-node'
import {
  KINGUD_WINDOWS_ENTRY_MARKER,
  KINGUD_WINDOWS_RUNTIME_MARKER
} from './kingud-windows-host-script'
import {
  KINGUD_LOG_FILENAME,
  KINGUD_READINESS_FILENAME,
  KINGUD_WINDOWS_PROCESS_FILENAME
} from './kingud-remote-host-support'
import { kingudManagedLaunchEnv, type KingudLaunchSpec } from './kingud-remote-launch'
import { KINGUD_WINDOWS_LAUNCH_REFUSED_CODE } from '../kingud/kingud-host-unavailable'

export class KingudWindowsLaunchRefusedError extends Error {
  readonly code = KINGUD_WINDOWS_LAUNCH_REFUSED_CODE
  constructor(reason: string) {
    super(
      `The Windows host refused to start kingud outside the SSH session (${reason}). kingud needs ` +
        'a job that allows breakaway and a slot with the process-tree launcher; it never falls ' +
        'back to WMI.'
    )
    this.name = 'KingudWindowsLaunchRefusedError'
  }
}

/** Resolves the slot's node.exe and clears a stop request the previous process never consumed. */
export function windowsKingudLaunchRuntimeCommand(
  host: RemoteHostPlatform,
  slotDir: string
): string {
  return kingudWindowsSlotOpCommand(host, slotDir, 'slot-runtime', [slotDir, 'clear-stop-request'])
}

export function readWindowsKingudSlotRuntime(output: string): string {
  const runtime = readKingudWindowsEncodedAnswer(output, KINGUD_WINDOWS_RUNTIME_MARKER)
  if (!runtime) {
    throw new Error('The Windows host did not name the runtime this kingud slot needs.')
  }
  return runtime
}

/** Older host-script answers omit the entry; those slots used the single-file launcher. */
export function readWindowsKingudSlotEntry(
  output: string,
  host: RemoteHostPlatform,
  slotDir: string
): string {
  return (
    readKingudWindowsEncodedAnswer(output, KINGUD_WINDOWS_ENTRY_MARKER) ??
    joinRemotePath(host, slotDir, 'kingud.js')
  )
}

export function windowsKingudLaunchCommand(
  host: RemoteHostPlatform,
  spec: KingudLaunchSpec,
  slotRuntime: string,
  slotEntry = joinRemotePath(host, spec.remoteInstallDir, 'kingud.js')
): string {
  const dir = spec.remoteInstallDir
  return kingudWindowsNodeCommandLine(slotRuntime, [
    slotEntry,
    WINDOWS_BREAKAWAY_LAUNCH_FLAG,
    // The addon creates both with CREATE_ALWAYS, so a previous run's readiness line is gone
    // before the launcher returns.
    WINDOWS_BREAKAWAY_STDOUT_FLAG,
    joinRemotePath(host, dir, KINGUD_READINESS_FILENAME),
    WINDOWS_BREAKAWAY_STDERR_FLAG,
    joinRemotePath(host, dir, KINGUD_LOG_FILENAME),
    // POSIX appends kingud.log; keep the last run's (a crash cause) across a restart here too.
    WINDOWS_BREAKAWAY_STDERR_KEEP_PREVIOUS_FLAG,
    WINDOWS_BREAKAWAY_PROCESS_FILE_FLAG,
    joinRemotePath(host, dir, KINGUD_WINDOWS_PROCESS_FILENAME),
    WINDOWS_BREAKAWAY_ENV_FLAG,
    `KINGU_VERSION=${spec.fullVersion}`,
    WINDOWS_BREAKAWAY_ENV_FLAG,
    `KINGU_USER_DATA=${spec.userDataDir}`,
    ...kingudManagedLaunchEnv(spec).flatMap(([name, value]) => [
      WINDOWS_BREAKAWAY_ENV_FLAG,
      `${name}=${value}`
    ]),
    KINGUD_WINDOWS_BREAKAWAY_CONTRACT.argsFlag,
    '--json',
    '--bind',
    spec.bindHost,
    '--port',
    String(spec.port)
  ])
}

/** The launched PID, or a refusal (no breakaway route) or failure the deploy must surface. */
export function readWindowsKingudLaunchReport(output: string): number {
  const report = parseWindowsBreakawayLaunchReport(KINGUD_WINDOWS_BREAKAWAY_CONTRACT, output)
  if (report?.method === 'breakaway') {
    return report.pid
  }
  if (report?.method === 'unavailable') {
    throw new KingudWindowsLaunchRefusedError(
      report.step ? `${report.reason} at ${report.step}` : report.reason
    )
  }
  const detail =
    report?.method === 'failed'
      ? `${report.reason}${report.step ? ` at ${report.step}` : ''} (code ${String(report.code ?? 0)})`
      : 'no launch report'
  throw new Error(`kingud's Windows launcher did not start the candidate: ${detail}.`)
}
