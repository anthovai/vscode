import type { ServeReadiness } from '../server/serve-readiness'
import type { KinguRuntimeRpcServer } from '../runtime/runtime-rpc'
import { buildServePairingReadiness } from '../server/serve-pairing-readiness'
import type { KingudHealth } from './kingud-health'
import type { KingudOptions } from './kingud-entry'

/** The readiness payload kingud publishes once its RPC transport is listening. */
export async function buildKingudServeReadiness(input: {
  options: KingudOptions
  runtimeId: string
  rpc: Pick<KinguRuntimeRpcServer, 'getWebSocketEndpoint' | 'createPairingOffer'>
  collectHealth: () => Promise<KingudHealth>
}): Promise<ServeReadiness> {
  return {
    runtimeId: input.runtimeId,
    ...(await buildServePairingReadiness(input.options, input.rpc)),
    // Why 'settled': the WSL CLI reconciliation barrier is a desktop-launch concern.
    // kingud never runs it, so there is no pending repair a client could race.
    managedWslCliReconciliation: 'settled',
    // Why in the readiness payload: this is the one message a supervisor and a deploy
    // transaction both read, and a green kingud with a dead daemon is exactly the
    // looks-healthy-but-useless state they must not activate.
    health: await input.collectHealth()
  }
}
