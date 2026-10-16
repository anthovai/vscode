/**
 * Proving the runtime behind a managed tunnel is this environment's kingud. A port held by another
 * runtime still accepts the connection, so a forward that opened proves nothing; only a status
 * call that completes the pairing handshake and reports the paired runtime id does.
 */
import { parsePairingCode } from '../../shared/pairing'
import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from '../../shared/paired-runtime-connection'
import { KINGUD_MANAGED_REMOTE_PORT } from '../../shared/kingud-managed-runtime'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../shared/remote-runtime-client-error-classification'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { verifyRuntimePairingIdentity } from '../runtime/runtime-environment-identity-verification'
import type { ServeReadiness } from '../server/serve-readiness'
import { kingudBoundPort } from './kingud-managed-bound-port'
import { tunneledKingudPairingCode } from './kingud-tunneled-pairing'

/** `unreachable` means nothing answered; it is never evidence about which server holds the port. */
export type KingudTunnelIdentity =
  | { verdict: 'verified' }
  | { verdict: 'foreign' | 'unreachable'; detail: string }

export const KINGUD_IDENTITY_MISMATCH_CODE = 'kingud_identity_mismatch'

export class KingudManagedIdentityError extends Error {
  readonly code = KINGUD_IDENTITY_MISMATCH_CODE
  constructor(remotePort: number, detail: string) {
    super(
      `${KINGUD_IDENTITY_MISMATCH_CODE}: the server on remote port ${remotePort} is not this ` +
        `managed Kingu server (another Kingu may be using that port): ${detail}`
    )
    this.name = 'KingudManagedIdentityError'
  }
}

// Why 4001/4003: a runtime that rejects our keys closes the socket rather than replying.
const FOREIGN_CLOSE_CODES = new Set([4001, 4003])

export function classifyKingudTunnelIdentityFailure(error: unknown): KingudTunnelIdentity {
  const detail = error instanceof Error ? error.message : String(error)
  if (error instanceof RemoteRuntimeClientError && FOREIGN_CLOSE_CODES.has(error.closeCode ?? 0)) {
    return { verdict: 'foreign', detail }
  }
  return isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
    ? { verdict: 'unreachable', detail }
    : { verdict: 'foreign', detail }
}

export async function verifyKingudPairingIdentity(
  connection: PairedRuntimeConnection,
  expected: Pick<KnownRuntimeEnvironment, 'runtimeId' | 'pairedDeviceId'>
): Promise<KingudTunnelIdentity> {
  try {
    await verifyRuntimePairingIdentity(connection, expected)
    return { verdict: 'verified' }
  } catch (error) {
    return classifyKingudTunnelIdentityFailure(error)
  }
}

/** Independent SSH access proved its identity when it linked; only managed kingud is checked. */
export function verifyManagedKingudTunnelIdentity(
  environment: KnownRuntimeEnvironment
): Promise<KingudTunnelIdentity> {
  if (!environment.kingudDeployment) {
    return Promise.resolve({ verdict: 'verified' })
  }
  // Why no runtime id: it is minted per process, so a restart by another desktop, or while this one
  // was away, changes it. The E2EE handshake with our pinned host key and our token being accepted
  // prove the server; the first authenticated status reply records the new id. Why no device id:
  // one left stale by a racing reply must not block it either.
  return verifyKingudPairingIdentity(getPreferredPairedRuntimeConnection(environment), {
    runtimeId: null
  })
}

/**
 * A fresh deploy has no saved environment yet: its pairing comes from the readiness, and a
 * foreign answer re-reads that readiness, whose bound endpoint the tunnel then follows.
 */
export function deployedKingudTunnelChecks(
  initial: ServeReadiness,
  rereadReadiness: () => Promise<ServeReadiness>
) {
  let readiness = initial
  return {
    readiness: () => readiness,
    remotePort: kingudBoundPort(initial) ?? KINGUD_MANAGED_REMOTE_PORT,
    rereadRemotePort: async () => {
      readiness = await rereadReadiness()
      return kingudBoundPort(readiness) ?? KINGUD_MANAGED_REMOTE_PORT
    },
    verify: async (localPort: number): Promise<KingudTunnelIdentity> => {
      const pairing = parsePairingCode(tunneledKingudPairingCode(readiness, localPort))
      return pairing
        ? verifyKingudPairingIdentity(pairedRuntimeConnectionFromOffer(pairing), {
            runtimeId: readiness.runtimeId || null
          })
        : { verdict: 'foreign', detail: 'The managed Kingu server published an invalid pairing.' }
    }
  }
}
