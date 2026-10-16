/**
 * The serving check behind an established managed tunnel. A restarted kingud may bind a port
 * other than the one the tunnel forwards to; the forward is then dropped, and the next build
 * forwards to the port the new server actually bound.
 */
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { KingudManagedServing } from './kingud-managed-serving'
import type { KingudManagedServingCheck } from './kingud-managed-tunnel-resume'
import type { ActiveKingudTunnel } from './kingud-managed-tunnel-active'
import type { SshPortForwardManager } from './ssh-port-forward'
import type { SshTarget } from '../../shared/ssh-types'

export type KingudTunnelServing = KingudManagedServing & { rebind?: true }

export async function checkManagedTunnelServing(input: {
  environment: KnownRuntimeEnvironment
  active: Map<string, ActiveKingudTunnel>
  getTarget: (targetId: string) => SshTarget | null | undefined
  forwards: Pick<SshPortForwardManager, 'removeForwardAndWait'>
  ensureServing: KingudManagedServingCheck | undefined
}): Promise<KingudTunnelServing> {
  const { environment, active: tunnels } = input
  const active = tunnels.get(environment.id)
  const target = active && input.getTarget(active.targetId)
  if (!active || !target || !input.ensureServing) {
    return { state: 'unverifiable', detail: 'The managed server tunnel is not up.' }
  }
  const serving = await input.ensureServing({
    environment,
    target,
    connection: active.connection,
    remotePort: active.remotePort
  })
  if (
    serving.state !== 'started' ||
    serving.boundPort === null ||
    serving.boundPort === active.remotePort
  ) {
    return serving
  }
  if (tunnels.get(environment.id) === active) {
    tunnels.delete(environment.id)
  }
  await input.forwards.removeForwardAndWait(active.forwardId)
  return { ...serving, rebind: true }
}
