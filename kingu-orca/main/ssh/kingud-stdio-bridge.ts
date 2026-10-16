/** Which command runs the stdio bridge on a host, and whether it can run there at all. */
import {
  KingudHostUnsupportedError,
  KingudStdioBridgeUnavailableError
} from '../kingud/kingud-host-unavailable'
import { resolveKingudRemoteContext } from './kingud-remote-context'
import { kingudWindowsHomeOpCommand } from './kingud-remote-windows-node'
import {
  kingudPosixStdioBridgeCommand,
  type KingudStdioBridgeMode
} from './kingud-stdio-bridge-script'
import {
  KingudStdioBridgeDecoder,
  type KingudStdioBridgeSignal
} from './kingud-stdio-bridge-stream'
import { isWslKingudHostTarget, type KingudHostTransport } from './kingud-host-transport'
import type { RemoteCommandChannel } from './remote-install-transport'
import { isWindowsRemoteHost } from './ssh-remote-platform'
import { detectRemoteHostPlatform } from './ssh-remote-platform-detection'

export type KingudStdioBridge = {
  command: string
  mode: KingudStdioBridgeMode
  wrapCommand: boolean
}

export const KINGUD_STDIO_BRIDGE_CHECK_TIMEOUT_MS = 20_000
const MAX_STDERR_TAIL_CHARS = 2_000
// POSIX shells and cmd.exe report a command they cannot find with these.
const COMMAND_NOT_FOUND_EXITS: ReadonlySet<number | null> = new Set([127, 9009])

export async function resolveKingudStdioBridge(
  conn: KingudHostTransport,
  port: number
): Promise<KingudStdioBridge> {
  const host = await detectRemoteHostPlatform(conn)
  if (!host) {
    throw new KingudHostUnsupportedError(
      'This SSH host platform is not supported by managed kingud.'
    )
  }
  if (!isWindowsRemoteHost(host)) {
    return { command: kingudPosixStdioBridgeCommand(port), mode: 'raw', wrapCommand: true }
  }
  const target = conn.getTarget()
  // A WSL distro is a Linux host, so a Windows answer from it is not one this path can serve.
  if (isWslKingudHostTarget(target)) {
    throw new KingudHostUnsupportedError('This WSL distro reported a Windows host platform.')
  }
  // Stages this client's pinned node.exe and host script, which an app update may have changed.
  const context = await resolveKingudRemoteContext(target, conn, undefined, host)
  return {
    command: kingudWindowsHomeOpCommand(host, context.remoteHome, 'stdio-bridge', [String(port)]),
    mode: 'base64',
    wrapCommand: host.commandDialect !== 'powershell'
  }
}

export function openKingudStdioBridgeChannel(
  conn: KingudHostTransport,
  bridge: KingudStdioBridge
): Promise<RemoteCommandChannel> {
  return conn.exec(bridge.command, { wrapCommand: bridge.wrapCommand })
}

function closeQuietly(channel: RemoteCommandChannel): void {
  try {
    channel.close()
  } catch {
    // Already closed.
  }
}

/**
 * Runs the bridge once. Any sentinel proves it runs, even when kingud's port refused it. Only an
 * exit the host reported without one is proof it can't run; anything else is unverifiable.
 */
export async function checkKingudStdioBridge(
  conn: KingudHostTransport,
  bridge: KingudStdioBridge,
  timeoutMs = KINGUD_STDIO_BRIDGE_CHECK_TIMEOUT_MS
): Promise<'running' | 'unverifiable'> {
  let channel: RemoteCommandChannel
  try {
    channel = await openKingudStdioBridgeChannel(conn, bridge)
  } catch {
    return 'unverifiable'
  }
  const decoder = new KingudStdioBridgeDecoder(bridge.mode)
  let stderr = ''
  let exitCode: number | null = null
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => settle('unverifiable'), timeoutMs)
    function settle(verdict: 'running' | 'unverifiable' | Error): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      closeQuietly(channel)
      decoder.destroy()
      if (verdict instanceof Error) {
        reject(verdict)
      } else {
        resolve(verdict)
      }
    }
    const unavailable = (detail: string): Error =>
      new KingudStdioBridgeUnavailableError(
        `The SSH host could not run the managed Kingu server's stdio bridge: ${detail}`
      )
    decoder.on('signal', (signal: KingudStdioBridgeSignal) => {
      settle(signal === 'no-node' ? unavailable('no pinned Node runtime') : 'running')
    })
    decoder.on('error', () => settle('unverifiable'))
    decoder.resume()
    channel.pipe(decoder)
    channel.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_TAIL_CHARS)
    })
    channel.on('exit', (code: unknown) => {
      exitCode = typeof code === 'number' ? code : null
    })
    channel.on('close', () => {
      // Why only command-not-found: a lost channel, or a script cut short (a concurrent host-script
      // write, a killed node.exe), proves nothing permanent about the host.
      settle(
        COMMAND_NOT_FOUND_EXITS.has(exitCode)
          ? unavailable(`exit ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
          : 'unverifiable'
      )
    })
    channel.on('error', () => settle('unverifiable'))
  })
}
