/**
 * The desktop's only way into a WSL distro's kingud (design D2): a loopback listener whose every
 * accepted socket rides its own `wsl.exe` child running the stdio bridge on the distro's pinned
 * Node. WSL localhost forwarding is never used: it refuses connections for 0.2–1 s after a listen
 * and depends on the distro's networking mode.
 */
import type { KingudHostTransport } from '../ssh/kingud-host-transport'
import {
  KINGUD_STDIO_BRIDGE_DEPENDENCIES,
  startKingudStdioBridge,
  type KingudStdioBridgeDependencies
} from '../ssh/kingud-stdio-bridge-provider'
import type { StartedPortForward } from '../ssh/ssh-port-forward-provider'

export type WslKingudStdioBridgeOptions = {
  environmentId: string
  /** kingud's loopback port inside the distro. */
  remotePort: number
  /** 0 picks a free one. */
  localPort: number
  label: string
}

export function listenWslKingudStdioBridge(
  transport: KingudHostTransport,
  options: WslKingudStdioBridgeOptions,
  dependencies: KingudStdioBridgeDependencies = KINGUD_STDIO_BRIDGE_DEPENDENCIES
): Promise<StartedPortForward> {
  return startKingudStdioBridge(
    transport,
    {
      id: `wsl-kingud:${options.environmentId}`,
      connectionId: options.environmentId,
      localHost: '127.0.0.1',
      localPort: options.localPort,
      remoteHost: '127.0.0.1',
      remotePort: options.remotePort,
      label: options.label
    },
    dependencies
  )
}
