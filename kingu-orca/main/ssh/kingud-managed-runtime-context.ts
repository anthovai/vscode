import { resolveEnvironment } from '../../shared/runtime-environment-store'
import {
  getKingudSshDeployment,
  type KnownRuntimeEnvironment,
  type KingudSshDeploymentLink
} from '../../shared/runtime-environments'
import { getManagedKingudFenceEnvironmentId } from '../../shared/managed-kingud-ssh-owner'
import type { ServeReadiness } from '../server/serve-readiness'
import { computeLocalKingudBuildHash } from './kingud-local-build-hash'
import { sshKingudHostTransport } from './kingud-ssh-host-transport'
import type { KingudHostTarget } from './kingud-host-transport'
import type { KingudActivationRecord } from './kingud-activation-record'
import { refuseKingudHostDowngrade } from './kingud-host-version-admission'
import type { KingudTerminalCensus } from './kingud-update-plan'
import { probeActiveKingudReadiness } from './kingud-active-readiness'
import { resolveKingudRemoteContext, type KingudRemoteContext } from './kingud-remote-context'
import { KINGUD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir } from './remote-versioned-install'
import { getSshConnectionManager, getSshTargetRegistryStore } from './ssh-target-registry'

export const KINGUD_BIND_HOST = '127.0.0.1'

// Why empty: managed slots always carry their pinned runtime marker, so a marker-less slot
// fails to launch instead of silently running on whatever Node the host has.
export const MANAGED_KINGUD_LEGACY_NODE_PATH = ''

export function requireManagedKingudInfrastructure() {
  const targetStore = requireManagedKingudTargetStore()
  const connectionManager = getSshConnectionManager()
  if (!connectionManager) {
    throw new Error('SSH is unavailable on this client; the managed Kingu server is unverifiable.')
  }
  return { connectionManager, targetStore, claims: targetStore.getKingudRuntimeClaims() }
}

export function requireManagedKingudTargetStore() {
  const targetStore = getSshTargetRegistryStore()
  if (!targetStore) {
    throw new Error('SSH target state is unavailable; the managed Kingu server is unverifiable.')
  }
  return targetStore
}

export function requireManagedKingudEnvironment(
  userDataPath: string,
  selector: string
): { environment: KnownRuntimeEnvironment; deployment: KingudSshDeploymentLink } {
  const environment = resolveEnvironment(userDataPath, selector)
  const deployment = getKingudSshDeployment(environment)
  if (!deployment || environment.connectionDependency !== 'ssh-tunnel') {
    throw new Error('This server is not managed through an kingud SSH deployment.')
  }
  return { environment, deployment }
}

export async function resolveLinkedKingudContext(
  environment: KnownRuntimeEnvironment,
  deployment: KingudSshDeploymentLink,
  signal?: AbortSignal
): Promise<KingudRemoteContext> {
  const { connectionManager, targetStore } = requireManagedKingudInfrastructure()
  const target = targetStore.getTarget(deployment.sshTargetId)
  if (
    !target ||
    target.generation !== deployment.sshTargetGeneration ||
    getManagedKingudFenceEnvironmentId(target) !== environment.id
  ) {
    throw new Error('The managed Kingu server SSH registration is no longer valid.')
  }
  const connection = await connectionManager.connect(target)
  return resolveKingudRemoteContext(target, sshKingudHostTransport(connection), signal)
}

/** The slot options every remote lifecycle step takes for this managed server. */
export function managedKingudSlot(
  context: KingudRemoteContext<KingudHostTarget>,
  port: number,
  signal?: AbortSignal
) {
  return {
    conn: context.connection,
    host: context.host,
    remoteHome: context.remoteHome,
    nodePath: MANAGED_KINGUD_LEGACY_NODE_PATH,
    userDataDir: context.userDataDir,
    bindHost: KINGUD_BIND_HOST,
    port,
    signal
  }
}

export function managedKingudInstallDir(
  context: KingudRemoteContext<KingudHostTarget>,
  version: string
): string {
  return computeRemoteInstallDir(
    KINGUD_INSTALL_MODEL,
    context.remoteHome,
    version,
    context.host.pathFlavor
  )
}

/** The active slot's readiness, accepted only if it is the build this client holds. */
export function probeManagedKingudReadiness(
  context: KingudRemoteContext<KingudHostTarget>,
  localKingudDir: string,
  fullVersion: string,
  signal?: AbortSignal
): Promise<ServeReadiness> {
  return probeActiveKingudReadiness(
    {
      conn: context.connection,
      host: context.host,
      remoteInstallDir: managedKingudInstallDir(context, fullVersion),
      signal
    },
    { buildHash: computeLocalKingudBuildHash(localKingudDir), fullVersion }
  )
}

/** The census and version admission every first deploy onto a host applies, SSH or WSL. */
export function managedKingudDeployPolicy(
  context: Pick<KingudRemoteContext<KingudHostTarget>, 'activationRecord'>,
  appVersion: string,
  force?: boolean
): {
  census: KingudTerminalCensus
  censusRecord: KingudActivationRecord
  admitRecord: (record: KingudActivationRecord, candidateVersion: string) => string | null
} {
  return {
    // Why unknown when a version is active: only the daemon can count its sessions, and
    // a deploy that guessed zero would restart over live terminals.
    census: context.activationRecord.active
      ? { liveSessions: null, startedSinceActivation: null, daemonProtocolVersion: null }
      : { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null },
    censusRecord: context.activationRecord,
    // Why: a host another desktop stopped may hold state its newer build migrated, and this
    // path has no linked record to check first, so only the fenced read can refuse it.
    // An explicit force runs this version anyway, as `environment update --force` does.
    admitRecord: (record, candidateVersion) =>
      !force && refuseKingudHostDowngrade(record, candidateVersion, appVersion)
        ? `Kingu ${record.activeAppVersion} last ran this host's server, newer than this ` +
          `Kingu (${appVersion}). Update Kingu to start it.`
        : null
  }
}

// Why only this code: deploy never has a session count to force past, so forcing an unknown
// census lands on the daemon-protocol deferral, which force cannot clear.
export function isForceableKingudDeferral(code: string): boolean {
  return code === 'kingud_update_terminals_running'
}
