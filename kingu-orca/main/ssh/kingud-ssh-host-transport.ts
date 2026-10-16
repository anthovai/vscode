import type { KingudHostTransport } from './kingud-host-transport'
import type { SshConnection } from './ssh-connection'

/**
 * An SSH host's kingud transport is its connection itself, not a wrapper: tunnel ownership, serving
 * dedupe and per-connection caches compare and key by that object.
 */
export function sshKingudHostTransport(connection: SshConnection): KingudHostTransport {
  return connection
}
