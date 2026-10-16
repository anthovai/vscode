/**
 * The liveness watch: one bridge into kingud's port, held open and never written to. kingud's HTTP
 * server keeps a connection that never sent a request, so the bridge ends only when kingud closes
 * it (exit 0, measured ~69 ms after killing kingud) or its distro stops (exit 1, ~40 ms after
 * `wsl --terminate`). Opening it doubles as the port probe: READY or REFUSED.
 */
import type { KingudHostTransport } from '../ssh/kingud-host-transport'
import { openKingudStdioBridgeChannel, resolveKingudStdioBridge } from '../ssh/kingud-stdio-bridge'
import {
  KingudStdioBridgeDecoder,
  type KingudStdioBridgeSignal
} from '../ssh/kingud-stdio-bridge-stream'
import type { RemoteCommandChannel } from '../ssh/remote-install-transport'

export type WslKingudWatch = {
  /** `ready` holds a live channel; anything else holds nothing. */
  signal: 'ready' | 'refused' | 'unverifiable'
  /** Called once, with the bridge's exit code, when a `ready` watch ends on its own. */
  onExit(listener: (code: number | null) => void): void
  close(): void
}

const WATCH_OPEN_TIMEOUT_MS = 10_000

function inertWatch(signal: 'refused' | 'unverifiable'): WslKingudWatch {
  return { signal, onExit: () => {}, close: () => {} }
}

export async function openWslKingudWatch(
  transport: KingudHostTransport,
  port: number,
  timeoutMs = WATCH_OPEN_TIMEOUT_MS
): Promise<WslKingudWatch> {
  let channel: RemoteCommandChannel
  try {
    channel = await openKingudStdioBridgeChannel(
      transport,
      await resolveKingudStdioBridge(transport, port)
    )
  } catch {
    return inertWatch('unverifiable')
  }
  return watchChannel(channel, timeoutMs)
}

/** Exported for tests: any channel speaking the bridge's sentinel protocol. */
export function watchChannel(
  channel: RemoteCommandChannel,
  timeoutMs: number
): Promise<WslKingudWatch> {
  const decoder = new KingudStdioBridgeDecoder('raw')
  let exitCode: number | null = null
  let ended = false
  let closedByUs = false
  let exitListener: ((code: number | null) => void) | null = null
  const close = (): void => {
    closedByUs = true
    try {
      channel.close()
    } catch {
      // Already gone.
    }
    decoder.destroy()
  }
  channel.on('exit', (code: unknown) => {
    exitCode = typeof code === 'number' ? code : null
  })
  channel.on('error', () => {})
  decoder.on('error', () => {})
  decoder.resume()
  channel.pipe(decoder)
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => settle('unverifiable'), timeoutMs)
    function settle(signal: KingudStdioBridgeSignal | 'unverifiable'): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (signal !== 'ready') {
        close()
        resolve(inertWatch(signal === 'refused' ? 'refused' : 'unverifiable'))
        return
      }
      resolve({
        signal: 'ready',
        onExit: (listener) => {
          exitListener = listener
          if (ended && !closedByUs) {
            listener(exitCode)
          }
        },
        close
      })
    }
    decoder.on('signal', (signal: KingudStdioBridgeSignal) => settle(signal))
    channel.on('close', (code: unknown) => {
      ended = true
      exitCode ??= typeof code === 'number' ? code : null
      settle('unverifiable')
      if (!closedByUs) {
        exitListener?.(exitCode)
        exitListener = null
      }
    })
  })
}
