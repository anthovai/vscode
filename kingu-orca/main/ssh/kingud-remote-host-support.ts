/**
 * Which hosts the kingud launch/lifecycle path actually supports, declared rather than
 * discovered at runtime.
 *
 * The install transaction is host-agnostic — it is the relay's, and the relay runs on
 * Windows. Every managed-kingud operation runs on Windows through the host script
 * (`kingud-windows-host-script.ts`); the guard below remains only on POSIX command builders
 * that the Windows paths never call.
 */
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

export class KingudRemoteLaunchUnsupportedError extends Error {
  readonly code = 'kingud_remote_launch_unsupported_host'
  constructor(hostLabel: string) {
    super(
      `This kingud command does not run on a ${hostLabel} host. The install transaction is ` +
        'host-agnostic, but this step is a POSIX command with a separate Windows path.'
    )
    this.name = 'KingudRemoteLaunchUnsupportedError'
  }
}

export function assertPosixKingudHost(host: RemoteHostPlatform): void {
  if (isWindowsRemoteHost(host)) {
    throw new KingudRemoteLaunchUnsupportedError('Windows')
  }
}

/** Stdout of the launched candidate: exactly one `kingu_server_ready` line, then nothing. */
export const KINGUD_READINESS_FILENAME = '.kingud-readiness'
/** Stderr, including the bind-exposure line and every supervision message. */
export const KINGUD_LOG_FILENAME = 'kingud.log'
// Why a cap: the readiness file is candidate-written stdout, and a runaway writer must not be read whole.
export const KINGUD_READINESS_MAX_BYTES = 256 * 1024

/** PID of the launched kingud, written into its own version dir at launch. */
export const KINGUD_PID_FILENAME = '.kingud-pid'
/** Windows' `.kingud-pid`: `{"pid":N,"creationTimeMs":M|null}`, since a PID alone is no identity there. */
export const KINGUD_WINDOWS_PROCESS_FILENAME = '.kingud-process.json'

/**
 * A shell function answering whether a PID is a *running* process.
 *
 * `kill -0` alone is not that question. It succeeds for a zombie — a process that has
 * exited but whose parent has not reaped it — so a stop loop built on it reports
 * `STILL_RUNNING` for a process that is already gone, and GC reports a dead version dir as
 * in use. Verified against a real zombie on macOS; the `ps` state check is what separates
 * the two.
 *
 * A host without `ps` yields an empty state, which falls through to "alive" — the safe
 * direction for both callers.
 */
export function posixProcessAliveShellFunction(
  options: { refuseUnverifiable?: boolean } = {}
): string {
  // Destructive lifecycle steps need explicit absence; permission failures cannot prove exit.
  const probe = options.refuseUnverifiable
    ? 'probe_error=$(LC_ALL=C kill -0 "$1" 2>&1) || { ' +
      'case "$probe_error" in *"No such process"*) return 1;; ' +
      '*) echo UNKNOWN; exit 0;; esac; }; '
    : 'kill -0 "$1" 2>/dev/null || return 1; '
  return (
    `kingud_alive() { ${probe}` +
    'case "$(ps -o stat= -p "$1" 2>/dev/null)" in Z*) return 1;; esac; return 0; };'
  )
}
