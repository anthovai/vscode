import { isWslHostsInternalGateOpen } from '../../shared/wsl-host-internal-gate'
import type { KingudDeploymentLink } from '../../shared/runtime-environments'

export const WSL_HOSTS_GATED_OFF_MESSAGE = 'WSL hosts are not available in this build.'

export function wslHostsGateOpen(): boolean {
  return isWslHostsInternalGateOpen(process.env)
}

/** A persisted WSL host while the gate is closed: left on disk, but never listed or reached. */
export function isGatedOffWslHost(environment: {
  kingudDeployment?: KingudDeploymentLink | null
}): boolean {
  return environment.kingudDeployment?.kind === 'wsl' && !wslHostsGateOpen()
}

export function assertWslHostReachable(environment: {
  kingudDeployment?: KingudDeploymentLink | null
}): void {
  if (isGatedOffWslHost(environment)) {
    throw new Error(WSL_HOSTS_GATED_OFF_MESSAGE)
  }
}
