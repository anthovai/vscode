import { resolveEnvironment } from '../../shared/runtime-environment-store'
import type { KingudManagedServing } from './kingud-managed-serving'
import { verifyManagedTunnelServing } from './kingud-managed-tunnel'

/** After the tunnel: the server answers, or was proven stopped and started; never throws. */
export function verifyKingudManagedServing(
  userDataPath: string,
  selector: string
): Promise<KingudManagedServing> {
  return Promise.resolve()
    .then(() => verifyManagedTunnelServing(resolveEnvironment(userDataPath, selector)))
    .catch((error: unknown) => ({ state: 'unverifiable', detail: String(error) }))
}
