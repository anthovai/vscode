/** Which transport each host's managed tunnel last started on, for connect telemetry. */
export type KingudTunnelTransport = 'tcp_forward' | 'stdio_bridge'

// Keyed by the local target id, which never leaves this process.
const transports = new Map<string, KingudTunnelTransport>()

export function rememberKingudTunnelTransport(
  targetId: string,
  transport: KingudTunnelTransport
): void {
  transports.set(targetId, transport)
}

export function knownKingudTunnelTransport(targetId: string): KingudTunnelTransport | null {
  return transports.get(targetId) ?? null
}
