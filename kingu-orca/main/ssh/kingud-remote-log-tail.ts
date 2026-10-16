/**
 * The end of a slot's kingud.log, appended to a failed deploy, launch or rollback so the error
 * says why kingud stopped rather than only where its log is. Errors and the main log only; never
 * telemetry. Best-effort: a host that can't answer leaves the error as it was.
 */
import { redactString } from '../observability/redactor'
import { shellEscape } from './ssh-connection-utils'
import { KINGUD_LOG_FILENAME } from './kingud-remote-host-support'
import { execCommand } from './ssh-relay-exec-command'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  kingudWindowsSlotOpCommand,
  readKingudWindowsEncodedAnswer
} from './kingud-remote-windows-node'
import { KINGUD_WINDOWS_LOG_TAIL_MARKER } from './kingud-windows-host-script'
import type { KingudRemoteExecTarget } from './kingud-remote-runtime-control'

export const KINGUD_LOG_TAIL_LINES = 40
export const KINGUD_LOG_TAIL_MAX_BYTES = 8 * 1024
// Short, because it only decorates an error the caller already has.
const KINGUD_LOG_TAIL_TIMEOUT_MS = 10_000

export function kingudLogTailCommand(host: RemoteHostPlatform, slotDir: string): string {
  const log = joinRemotePath(host, slotDir, KINGUD_LOG_FILENAME)
  if (isWindowsRemoteHost(host)) {
    return kingudWindowsSlotOpCommand(host, slotDir, 'log-tail', [
      log,
      String(KINGUD_LOG_TAIL_MAX_BYTES)
    ])
  }
  return `tail -c ${KINGUD_LOG_TAIL_MAX_BYTES} ${shellEscape(log)} 2>/dev/null || true`
}

/** The last lines of what the host printed, redacted; null when the log is empty or absent. */
export function parseKingudLogTail(host: RemoteHostPlatform, output: string): string | null {
  const raw = isWindowsRemoteHost(host)
    ? (readKingudWindowsEncodedAnswer(output, KINGUD_WINDOWS_LOG_TAIL_MARKER) ?? '')
    : output
  const bounded = Buffer.from(raw, 'utf8').subarray(-KINGUD_LOG_TAIL_MAX_BYTES).toString('utf8')
  const lines = bounded.replace(/\s+$/u, '').split(/\r?\n/u).slice(-KINGUD_LOG_TAIL_LINES)
  const tail = redactString(lines.join('\n'))
  return tail.trim() ? tail : null
}

export async function readKingudLogTail(
  target: KingudRemoteExecTarget,
  slotDir: string
): Promise<string | null> {
  try {
    // No abort signal: the failure being reported may be the cancellation itself.
    const output = await execCommand(target.conn, kingudLogTailCommand(target.host, slotDir), {
      wrapCommand: target.host.commandDialect !== 'powershell',
      timeoutMs: KINGUD_LOG_TAIL_TIMEOUT_MS
    })
    return parseKingudLogTail(target.host, output)
  } catch (error) {
    console.warn('[ssh] Could not read the kingud.log tail:', error)
    return null
  }
}

/** `message` followed by the log tail, or `message` alone when the host had none to give. */
export async function withKingudLogTail(
  target: KingudRemoteExecTarget,
  slotDir: string,
  message: string
): Promise<string> {
  const tail = await readKingudLogTail(target, slotDir)
  return tail ? `${message}\nLast lines of kingud.log:\n${tail}` : message
}
