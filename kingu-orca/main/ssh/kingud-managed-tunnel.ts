import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshConnection } from './ssh-connection'
import { probeManagedKingudTunnel } from './kingud-managed-tunnel-resume'
import { ensureManagedKingudServing } from './kingud-managed-serving'
import { KingudManagedTunnelManager } from './kingud-managed-tunnel-manager'
import { getRemoteRuntimeSharedControlAnsweredAt } from '../ipc/runtime-environment-shared-control-answers'
import { getSshConnectionManager, getSshTargetRegistryStore } from './ssh-target-registry'
import {
  MANAGED_KINGUD_TUNNEL_TARGETING,
  type KingudTunnelStartChecks
} from './kingud-managed-tunnel-target'

export { KingudManagedTunnelManager } from './kingud-managed-tunnel-manager'

const managedTunnels = new KingudManagedTunnelManager({
  getConnectionManager: getSshConnectionManager,
  getTargetStore: getSshTargetRegistryStore,
  targeting: MANAGED_KINGUD_TUNNEL_TARGETING,
  ensureServing: (input) =>
    ensureManagedKingudServing({
      ...input,
      probe: probeManagedKingudTunnel,
      answeredAt: getRemoteRuntimeSharedControlAnsweredAt
    })
})

export async function ensureKingudManagedTunnel(
  userDataPath: string,
  selector: string
): Promise<void> {
  const environment = resolveEnvironment(userDataPath, selector)
  await managedTunnels.ensure(environment, () =>
    resolveEnvironmentOrNull(userDataPath, environment.id)
  )
}

/** After a redeploy: the reused forward may target the port the previous server bound. */
export async function rebuildKingudManagedTunnel(
  userDataPath: string,
  selector: string
): Promise<void> {
  const environment = resolveEnvironment(userDataPath, selector)
  await managedTunnels.rebuild(environment, () =>
    resolveEnvironmentOrNull(userDataPath, environment.id)
  )
}

function resolveEnvironmentOrNull(userDataPath: string, id: string) {
  try {
    return resolveEnvironment(userDataPath, id)
  } catch {
    return null
  }
}

export function verifyManagedTunnelServing(environment: KnownRuntimeEnvironment) {
  return managedTunnels.verifyServing(environment)
}

export function disposeKingudManagedTunnels(): void {
  managedTunnels.dispose()
}

/** Why on quit: a system-ssh tunnel is its own `ssh -L` process and would outlive Kingu. */
export function shutdownKingudManagedTunnels(): Promise<void> {
  return managedTunnels.shutdown()
}

export function recoverKingudManagedTunnelsAfterHostResume(
  userDataPath: string,
  options: { attempts: number; timeoutMs: number }
): Promise<void> {
  return managedTunnels.recoverAfterHostResume({
    ...options,
    resolveEnvironment: (environmentId) => resolveEnvironmentOrNull(userDataPath, environmentId)
  })
}

export function startKingudManagedTunnel(
  environmentId: string,
  target: SshTarget,
  connection: SshConnection,
  remotePort: number,
  checks?: KingudTunnelStartChecks
): Promise<number> {
  return managedTunnels.start(environmentId, target, connection, remotePort, checks)
}

export function closeKingudManagedTunnel(environmentId: string): Promise<void> {
  return managedTunnels.close(environmentId)
}
