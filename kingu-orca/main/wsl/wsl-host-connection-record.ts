/** What a WSL host's connection change writes to its records, and how the UI sees its status. */
import { refreshWslHostPairing } from '../../shared/runtime-environment-wsl-host-store'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type { WslHostStatus } from '../../shared/wsl-host-types'
import type { WslKingudConnection } from './wsl-kingud-connection'
import type { WslKingudConnectionStatus } from './wsl-kingud-connection-status'

/** Saves a relaunch's new device token or a moved bridge; true when the pairing changed. */
export function persistWslHostConnection(
  userDataPath: string,
  record: WslHostDeploymentRecord,
  connection: WslKingudConnection
): boolean {
  try {
    return refreshWslHostPairing(userDataPath, record.environmentId, {
      pairingCode: connection.pairingOffer,
      localPort: connection.localPort,
      remotePort: connection.remotePort
    }).pairingChanged
  } catch (error) {
    console.warn(`[wsl-hosts] Could not save the new pairing for ${record.distro}:`, error)
    return false
  }
}

export function toWslHostStatus(
  record: WslHostDeploymentRecord,
  status: WslKingudConnectionStatus,
  connection: WslKingudConnection | null = null
): WslHostStatus {
  return {
    environmentId: record.environmentId,
    distro: record.distro,
    state: status.state,
    detail: status.state === 'failed' || status.state === 'unverifiable' ? status.reason : null,
    // Only a ready host is serving the incumbent the deferral describes.
    deferredUpdate: status.state === 'ready' ? (connection?.deferredUpdate ?? null) : null
  }
}
