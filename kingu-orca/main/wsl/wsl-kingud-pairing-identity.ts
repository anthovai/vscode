import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { parsePairingCode } from '../../shared/pairing'
import type { ServeReadiness } from '../server/serve-readiness'
import {
  verifyKingudPairingIdentity,
  type KingudTunnelIdentity
} from '../ssh/kingud-managed-tunnel-identity'

/** Whether the server behind a WSL bridge is the kingud that published `readiness`. */
export async function verifyWslKingudIdentity(
  pairingOffer: string,
  readiness: ServeReadiness
): Promise<KingudTunnelIdentity> {
  const offer = parsePairingCode(pairingOffer)
  return offer
    ? verifyKingudPairingIdentity(pairedRuntimeConnectionFromOffer(offer), {
        runtimeId: readiness.runtimeId || null
      })
    : { verdict: 'foreign', detail: 'The Kingu server in WSL published an invalid pairing offer.' }
}
