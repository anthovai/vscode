/**
 * Waiting for a launched kingud's readiness line on the host, not across SSH.
 *
 * The client used to re-read the readiness file every 500 ms, one exec each, for up to three
 * minutes. A burst of short-lived processes under sshd is itself an EDR signal on Windows
 * (docs/reference/windows-edr-posture.md). One exec now waits host-side for a complete line, an
 * oversized file, or its own bounded deadline.
 */
import { shellEscape } from './ssh-connection-utils'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  KINGUD_READINESS_FILENAME,
  KINGUD_READINESS_MAX_BYTES,
  parseKingudReadinessOutput,
  readKingudReadinessCommand,
  type KingudReadinessParse
} from './kingud-remote-launch'
import {
  kingudWindowsSlotOpCommand,
  readKingudWindowsEncodedAnswer
} from './kingud-remote-windows-node'
import { KINGUD_WINDOWS_READINESS_MARKER } from './kingud-windows-host-script'

/** Under the 30 s exec timeout, so one wait never reads as an unanswered host. */
export const KINGUD_READINESS_WAIT_MAX_SECONDS = 20

/** Settles on a newline (a finished line) or more than the cap; both are final for the parser. */
function posixReadinessWaitCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  waitSeconds: number
): string {
  const file = shellEscape(joinRemotePath(host, remoteInstallDir, KINGUD_READINESS_FILENAME))
  const read = `head -c ${KINGUD_READINESS_MAX_BYTES + 1} ${file} 2>/dev/null`
  return [
    // Fractional sleep is not POSIX; probe it once so polling stays fine-grained where it can.
    'if sleep 0.25 2>/dev/null; then kingud_readiness_wait_step=0.25;',
    'else kingud_readiness_wait_step=1; fi;',
    // Why a wall-clock deadline, not a step count: on a loaded host each step's reads take far
    // longer than its sleep, a counted loop overran the client's exec timeout, and the launch
    // was failed while the candidate was still starting (BUG-17).
    `kingud_readiness_wait_end=$(($(date +%s) + ${waitSeconds}));`,
    'while [ "$(date +%s)" -lt "$kingud_readiness_wait_end" ]; do',
    `[ "$(${read} | wc -l)" -gt 0 ] && break;`,
    `[ "$(${read} | wc -c)" -gt ${KINGUD_READINESS_MAX_BYTES} ] && break;`,
    'sleep "$kingud_readiness_wait_step"; done;',
    `${read} || true`
  ].join(' ')
}

export function kingudReadinessWaitCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  waitSeconds: number
): string {
  const seconds = Math.max(0, Math.min(KINGUD_READINESS_WAIT_MAX_SECONDS, Math.ceil(waitSeconds)))
  if (!isWindowsRemoteHost(host)) {
    return posixReadinessWaitCommand(host, remoteInstallDir, seconds)
  }
  return kingudWindowsSlotOpCommand(host, remoteInstallDir, 'readiness-wait', [
    joinRemotePath(host, remoteInstallDir, KINGUD_READINESS_FILENAME),
    String(KINGUD_READINESS_MAX_BYTES),
    String(seconds)
  ])
}

/** What the readiness file held when the host stopped waiting; `pending` if still unfinished. */
export function parseKingudReadinessWaitOutput(
  host: RemoteHostPlatform,
  output: string
): KingudReadinessParse {
  return parseKingudReadinessOutput(
    isWindowsRemoteHost(host)
      ? (readKingudWindowsEncodedAnswer(output, KINGUD_WINDOWS_READINESS_MARKER) ?? '')
      : output
  )
}

/** Reads the readiness line as it stands; parse with `parseKingudReadinessWaitOutput`. */
export function readKingudReadinessNowCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  // Why: Windows has no `head`; its host script's wait op with no wait reads the same bytes.
  return isWindowsRemoteHost(host)
    ? kingudReadinessWaitCommand(host, remoteInstallDir, 0)
    : readKingudReadinessCommand(host, remoteInstallDir)
}
