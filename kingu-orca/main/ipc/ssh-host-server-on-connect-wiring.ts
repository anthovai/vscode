/** The live collaborators behind each connect's server decision. */
import { getAppEnvironment } from '../../shared/app-environment'
import {
  getManagedKingudFenceEnvironmentId,
  managedKingudServerName
} from '../../shared/managed-kingud-ssh-owner'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { findKingudMigrationSourceCutoverForTarget } from '../ssh/kingud-migration-cutover-journal'
import { abandonKingudConversion } from '../ssh/kingud-conversion-abandon'
import { retainKingudMigrationSource } from '../ssh/kingud-migration-source-retention'
import { hasKingudTemplate } from '../kingud/kingud-artifact-materializer'
import { managedServerUpdateDeps } from '../ssh/managed-server-update-deps'
import { ensureKingudManagedTunnel } from '../ssh/kingud-managed-tunnel'
import { verifyKingudManagedServing } from '../ssh/kingud-managed-serving-verify'
import { convertSshTargetToManagedKingud } from '../ssh/kingud-runtime-conversion'
import {
  kingudMigrationDestinationFor,
  kingudServerRepositoriesFor
} from '../ssh/kingud-runtime-conversion-wiring'
import { createManagedKingudEnvironment } from '../ssh/kingud-runtime-deployment'
import type { HostServerOnConnectDeps } from '../ssh/ssh-host-server-on-connect'
import {
  censusSshHostRelaysBeforeSession,
  relayTerminalsOnConnect
} from '../ssh/ssh-host-relay-terminals-on-connect'
import { requireManagedKingudInfrastructure } from '../ssh/kingud-managed-runtime-context'
import { censusHostRelayTerminalsFor } from '../ssh/ssh-host-relay-census-for-target'
import { setSshHostServerStatus } from '../ssh/ssh-host-server-status'
import { trackSshHostServerEvent } from '../ssh/ssh-host-server-telemetry'
import { knownSshHostPlatform } from '../ssh/ssh-host-platform-memo'
import { knownKingudTunnelTransport } from '../ssh/kingud-tunnel-transport-memo'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { releaseUnreachableKingudSetup } from '../ssh/kingud-unreachable-setup-release'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { broadcastSshState } from './ssh-renderer-broadcast'
import { connectInFlight } from './ssh-connect-attempt-registry'
import { startLegacyRelayBridge } from '../ssh/legacy-relay-bridge/legacy-relay-bridge-registry'

export function hostServerOnConnectDeps(userDataPath: string): HostServerOnConnectDeps {
  const registry = getSshTargetRegistryStore()!
  const claims = registry.getKingudRuntimeClaims()
  const store = registry.getKingudMigrationSource()
  const appVersion = getAppEnvironment().getVersion()
  const isRegistered = (environmentId: string): boolean =>
    listEnvironments(userDataPath).some((entry) => entry.id === environmentId)
  return {
    // Why registered only: a fence whose server never registered is an unfinished setup, not a server.
    managedEnvironmentId: (target) => {
      const environmentId = getManagedKingudFenceEnvironmentId(target)
      return environmentId && isRegistered(environmentId) ? environmentId : null
    },
    ensureTunnel: async (environmentId) => {
      await ensureKingudManagedTunnel(userDataPath, environmentId)
    },
    ensureServing: (environmentId) => verifyKingudManagedServing(userDataPath, environmentId),
    retainCommittedSource: (target) => {
      const head = findKingudMigrationSourceCutoverForTarget(userDataPath, target.id)
      if (head?.phase === 'destination-committed') {
        retainKingudMigrationSource(userDataPath, head.migrationId)
      }
    },
    hasTemplate: hasKingudTemplate,
    recordedUnavailable: (target) =>
      target.managedServerUnavailable?.appVersion === appVersion
        ? target.managedServerUnavailable.reason
        : null,
    recordUnavailable: (target, reason) => {
      registry.updateTarget(target.id, { managedServerUnavailable: { reason, appVersion } })
    },
    ...managedServerUpdateDeps(userDataPath),
    isEmptyHost: (target) => {
      // An interrupted empty-host deploy passes its own claim, recorded by its provisioning intent.
      const environmentId = getManagedKingudFenceEnvironmentId(target)
      return claims.preflight(
        target.id,
        environmentId
          ? { environmentId, recorded: target.kingudProvisioning !== undefined }
          : undefined
      ).claimable
    },
    relayTerminals: (target) =>
      relayTerminalsOnConnect({
        store,
        targetId: target.id,
        censusHost: async () =>
          censusSshHostRelaysBeforeSession(
            await requireManagedKingudInfrastructure().connectionManager.connect(target),
            target.id
          )
      }),
    deploy: (target) =>
      createManagedKingudEnvironment(userDataPath, {
        name: target.kingudProvisioning?.name ?? managedKingudServerName(target),
        sshTargetId: target.id
      }),
    convert: async (target, hostProof) => {
      // COMPAT(legacy-relay-bridge): find the panes old relays still run before the tabs remount.
      if (hostProof?.bridged) {
        await startLegacyRelayBridge(target.id)
      }
      const converted = await convertSshTargetToManagedKingud(userDataPath, {
        sshTargetId: target.id,
        name: managedKingudServerName(target),
        // The connect's own census already answered; a conversion before any session reuses it.
        censusHost: (host) =>
          hostProof ? Promise.resolve(hostProof) : censusHostRelayTerminalsFor(host)(),
        // Why no releaseDirectSession: a disconnect here would cancel the connect that asked for it.
        destinationFor: kingudMigrationDestinationFor,
        serverRepositoriesFor: kingudServerRepositoriesFor
      })
      if (converted.outcome === 'converted' || converted.outcome === 'refused') {
        // "Move anyway" covers one attempt; a later move, or a later delta, asks again.
        // Kept on a throw: verifyFence re-exports with it, so a held fence could never resume.
        registry.updateTarget(target.id, { managedServerLeaveBehind: undefined })
      }
      return converted
    },
    abandonDeploy: async (target) => {
      const environmentId =
        getManagedKingudFenceEnvironmentId(target) ??
        getManagedKingudFenceEnvironmentId(registry.getTarget(target.id))
      if (environmentId && !isRegistered(environmentId)) {
        claims.release(target.id, environmentId)
        await claims.flush()
      }
    },
    hasUnfinishedConversion: (target) => {
      const head = findKingudMigrationSourceCutoverForTarget(userDataPath, target.id)
      return (
        head !== null &&
        !head.supersedesMigrationId &&
        (head.phase === 'source-fenced' || head.phase === 'destination-staged')
      )
    },
    abandonConversion: async (target) => {
      await abandonKingudConversion({
        userDataPath,
        store,
        claims,
        targetId: target.id,
        destinationFor: kingudMigrationDestinationFor
      })
    },
    isFencedBeforeStaging: (target) =>
      findKingudMigrationSourceCutoverForTarget(userDataPath, target.id)?.phase === 'source-fenced',
    releaseUnreachableSetup: (target) =>
      releaseUnreachableKingudSetup({ userDataPath, claims, targetId: target.id }),
    // Read at report time: a deploy or conversion learns the platform while the decision runs.
    report: (target, event) =>
      trackSshHostServerEvent(
        event,
        knownSshHostPlatform(target.id),
        knownKingudTunnelTransport(target.id)
      ),
    progress: (target, phase) => {
      // A cancelled connect's decision keeps running; its progress must not revive the status.
      if (!connectInFlight.has(target.id)) {
        return
      }
      setSshHostServerStatus(target.id, { kind: 'setting-up', phase })
      broadcastSshState(getCurrentMainWindow, target.id, {
        targetId: target.id,
        status: 'connecting',
        error: null,
        reconnectAttempt: 0
      })
    }
  }
}
