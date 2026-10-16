/**
 * The port a managed kingud actually listens on. kingud asks for its preferred port but moves to a
 * free one when another runtime (a desktop Kingu, `kingu serve`) holds it, so a tunnel that assumed
 * the preferred port would reach that other runtime instead. The slot's readiness says which.
 */
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import type { ServeReadiness } from '../server/serve-readiness'
import { managedKingudInstallDir } from './kingud-managed-runtime-context'
import { resolveKingudRemoteContext } from './kingud-remote-context'
import {
  parseKingudReadinessWaitOutput,
  readKingudReadinessNowCommand
} from './kingud-remote-readiness-wait'
import { execKingudRemote, type KingudRemoteExecTarget } from './kingud-remote-runtime-control'
import type { KingudHostTransport } from './kingud-host-transport'

export type KingudTunnelPortInput = {
  environment: KnownRuntimeEnvironment
  target: SshTarget
  connection: KingudHostTransport
}

export function kingudBoundPort(readiness: Pick<ServeReadiness, 'boundEndpoint'>): number | null {
  if (!readiness.boundEndpoint) {
    return null
  }
  try {
    const port = Number(new URL(readiness.boundEndpoint).port)
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null
  } catch {
    return null
  }
}

/** Falls back to the preferred port only when the slot published no endpoint (older builds). */
export async function readManagedKingudBoundPort(
  target: KingudRemoteExecTarget & { remoteInstallDir: string },
  preferredPort: number
): Promise<number> {
  const parsed = parseKingudReadinessWaitOutput(
    target.host,
    await execKingudRemote(
      target,
      readKingudReadinessNowCommand(target.host, target.remoteInstallDir)
    )
  )
  return (parsed.state === 'ready' ? kingudBoundPort(parsed.readiness) : null) ?? preferredPort
}

/** Where a tunnel to this environment must point; independent SSH access keeps its own port. */
export async function resolveManagedKingudTunnelPort(
  input: KingudTunnelPortInput
): Promise<number> {
  const access = getRuntimeSshAccess(input.environment)
  if (!access) {
    throw new Error('Managed kingud environment is missing its SSH tunnel dependency.')
  }
  if (!input.environment.kingudDeployment) {
    return access.remotePort
  }
  try {
    const context = await resolveKingudRemoteContext(input.target, input.connection)
    const active = context.activationRecord.active
    if (!active) {
      return access.remotePort
    }
    return await readManagedKingudBoundPort(
      {
        conn: context.connection,
        host: context.host,
        remoteHome: context.remoteHome,
        remoteInstallDir: managedKingudInstallDir(context, active)
      },
      access.remotePort
    )
  } catch (error) {
    // Why fall back: the identity check after the forward still catches a wrong server.
    console.warn(
      '[ssh] Could not read the managed Kingu server port; trying the preferred one:',
      error
    )
    return access.remotePort
  }
}
