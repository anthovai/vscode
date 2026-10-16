/**
 * Deploys kingud onto an empty SSH host and pairs this client with it through a loopback tunnel.
 * The target claim is the resume point: an interrupted deploy leaves the target owned by the
 * environment id it was creating, and the next deploy of that target finishes the same one.
 */
import { getAppEnvironment } from '../../shared/app-environment'
import { randomUUID } from 'node:crypto'
import { assertRuntimeEnvironmentNotReconciling } from '../../shared/runtime-environment-reconciliation-record'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { addManagedKingudEnvironment } from '../../shared/runtime-environment-managed-kingud-store'
import { getKingudSshDeployment, redactRuntimeEnvironment } from '../../shared/runtime-environments'
import {
  KINGUD_MANAGED_REMOTE_PORT,
  type KingudManagedDeferral,
  type KingudManagedDeployResult
} from '../../shared/kingud-managed-runtime'
import { getManagedKingudFenceEnvironmentId } from '../../shared/managed-kingud-ssh-owner'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import { materializeKingudArtifact } from '../kingud/kingud-artifact-materializer'
import {
  closeKingudManagedTunnel,
  ensureKingudManagedTunnel,
  startKingudManagedTunnel
} from './kingud-managed-tunnel'
import { recoverInterruptedKingudActivation } from './kingud-activation-recovery'
import { wakeAlreadyActiveKingud } from './kingud-already-active-wake'
import { readKingudActivationRecord } from './kingud-activation-record-store'
import { resolveKingudRemoteContext, type KingudRemoteContext } from './kingud-remote-context'
import { deployKingud } from './kingud-remote-deploy'
import {
  adoptRunningKingudVersion,
  type KingudRunningAdoption
} from './kingud-running-version-adoption'
import { readLocalFullVersion } from './remote-versioned-install'
import { sshKingudHostTransport } from './kingud-ssh-host-transport'
import { KINGUD_ACTIVATION_POLICY_REFUSED_CODE } from './kingud-installed-activation'
import { pruneManagedKingudVersions } from './kingud-managed-version-gc'
import { tunneledKingudPairingCode } from './kingud-tunneled-pairing'
import { resolveKingudMigrationFence } from './kingud-migration-source-fence'
import type { SshTarget } from '../../shared/ssh-types'
import { deployedKingudTunnelChecks } from './kingud-managed-tunnel-identity'
import {
  isForceableKingudDeferral,
  managedKingudDeployPolicy,
  managedKingudSlot,
  probeManagedKingudReadiness,
  requireManagedKingudInfrastructure
} from './kingud-managed-runtime-context'

export async function createManagedKingudEnvironment(
  userDataPath: string,
  args: {
    name: string
    sshTargetId: string
    force?: boolean
    signal?: AbortSignal
    /** Deploying into a target fenced by a migration journal rather than claiming an empty one. */
    migration?: boolean
  }
): Promise<KingudManagedDeployResult> {
  return runTargetLifecycle(args.sshTargetId, async () => {
    const { connectionManager, targetStore, claims } = requireManagedKingudInfrastructure()
    const environmentId =
      getManagedKingudFenceEnvironmentId(targetStore.getTarget(args.sshTargetId)) ?? randomUUID()
    const environments = listEnvironments(userDataPath)
    const registered = environments.find((entry) => entry.id === environmentId)
    if (registered) {
      assertRuntimeEnvironmentNotReconciling(registered)
      if (getKingudSshDeployment(registered)?.sshTargetId !== args.sshTargetId) {
        throw new Error('The SSH target is owned by a server that is not deployed on it.')
      }
    }
    if (environments.some((entry) => entry.id !== environmentId && entry.name === args.name)) {
      throw new Error(`A server named "${args.name}" already exists.`)
    }
    const current = targetStore.getTarget(args.sshTargetId)
    if (args.migration) {
      assertMigrationFence(userDataPath, current, environmentId, args.name)
    }
    const claimed = claims.claim(args.sshTargetId, environmentId, {
      // A migration records itself in its journal, not as a provisioning intent.
      ...(args.migration ? {} : { deployName: args.name }),
      // Why: this deploy's own claim left a provisioning intent or a journal, or registered a server.
      ownerRecorded:
        Boolean(args.migration) || Boolean(current?.kingudProvisioning) || Boolean(registered)
    })
    await claims.flush(args.signal)
    const targetGeneration = claimed.generation
    if (targetGeneration === undefined) {
      throw new Error('The managed Kingu SSH registration has no durable generation.')
    }
    if (
      registered &&
      getKingudSshDeployment(registered)?.sshTargetGeneration !== targetGeneration
    ) {
      throw new Error('The saved managed Kingu server has a stale SSH target generation.')
    }
    let environmentRegistered = false
    try {
      const connection = await connectionManager.connect(claimed)
      let context = await resolveKingudRemoteContext(
        claimed,
        sshKingudHostTransport(connection),
        args.signal
      )
      const slot = managedKingudSlot(context, KINGUD_MANAGED_REMOTE_PORT, args.signal)
      const recovery = await recoverInterruptedKingudActivation(slot)
      if (recovery.outcome === 'pending' || recovery.outcome === 'refused') {
        throw new Error(recovery.reason)
      }
      if (recovery.outcome === 'recovered') {
        context = { ...context, activationRecord: await readKingudActivationRecord(slot) }
      }
      if (registered) {
        environmentRegistered = true
        await ensureKingudManagedTunnel(userDataPath, registered.id)
        const activeVersion = context.activationRecord.active
        if (!activeVersion) {
          throw new Error('The managed Kingu server has no active runtime version.')
        }
        return {
          outcome: 'already-current',
          environment: redactRuntimeEnvironment(registered),
          activeVersion
        }
      }
      const localKingudDir = await materializeKingudArtifact(context.serverTarget, {
        signal: args.signal
      })
      // Before any upload, so a host another version serves is left exactly as it was. A migration
      // adopts too: only the paired server can count its terminals, so its own deploy would defer.
      const localVersion = readLocalFullVersion(localKingudDir)
      const adopted = args.force
        ? null
        : await adoptRunningKingudVersion(slot, context.activationRecord, localVersion)
      const { active } = context.activationRecord
      if (!adopted && !args.force && active && active !== localVersion) {
        // The wake re-read a record another desktop changed; the census policy follows it.
        context = { ...context, activationRecord: await readKingudActivationRecord(slot) }
      }
      const serving: DeployedKingud | KingudManagedDeferral =
        adopted ??
        (await deployOwnKingud(context, { ...slot, conn: connection }, localKingudDir, args))
      if ('outcome' in serving) {
        return serving
      }
      // Why read back: kingud binds another port when the preferred one is taken on the host.
      const tunnel = deployedKingudTunnelChecks(serving.readiness, serving.reprobe)
      const localPort = await startKingudManagedTunnel(
        environmentId,
        claimed,
        connection,
        tunnel.remotePort,
        { ...tunnel, preferredPort: KINGUD_MANAGED_REMOTE_PORT }
      )
      const environment = addManagedKingudEnvironment(userDataPath, {
        id: environmentId,
        name: args.name,
        pairingCode: tunneledKingudPairingCode(tunnel.readiness(), localPort),
        kingudDeployment: {
          sshTargetId: claimed.id,
          sshTargetGeneration: targetGeneration,
          localPort,
          remotePort: KINGUD_MANAGED_REMOTE_PORT
        }
      })
      environmentRegistered = true
      return {
        // An adopted server keeps its version; the linked update check may replace it later.
        outcome: serving.created ? 'created' : 'already-current',
        environment: redactRuntimeEnvironment(environment),
        activeVersion: serving.version
      }
    } finally {
      if (!environmentRegistered) {
        await closeKingudManagedTunnel(environmentId).catch(() => undefined)
      }
    }
  })
}

type DeployedKingud = KingudRunningAdoption & { created?: true }

async function deployOwnKingud(
  context: KingudRemoteContext<SshTarget>,
  slot: ReturnType<typeof managedKingudSlot>,
  localKingudDir: string,
  args: { force?: boolean; signal?: AbortSignal }
): Promise<DeployedKingud | KingudManagedDeferral> {
  const appVersion = getAppEnvironment().getVersion()
  const deployResult = await deployKingud({
    ...slot,
    localKingudDir,
    target: context.serverTarget,
    ...managedKingudDeployPolicy(context, appVersion, args.force),
    force: args.force,
    appVersion
  })
  if (deployResult.outcome === 'installed-not-activated') {
    return {
      outcome: 'deferred',
      candidateVersion: deployResult.fullVersion,
      code: deployResult.code,
      reason: deployResult.reason,
      forceable:
        isForceableKingudDeferral(deployResult.code) ||
        deployResult.code === KINGUD_ACTIVATION_POLICY_REFUSED_CODE
    }
  }
  if (deployResult.outcome === 'already-active') {
    await wakeAlreadyActiveKingud(slot)
  }
  const reprobe = () =>
    probeManagedKingudReadiness(context, localKingudDir, deployResult.fullVersion, args.signal)
  const readiness = await reprobe()
  await pruneManagedKingudVersions({
    slot,
    serverTarget: context.serverTarget,
    activeVersion: deployResult.fullVersion,
    readiness
  })
  return {
    version: deployResult.fullVersion,
    readiness,
    reprobe,
    ...(deployResult.outcome === 'already-active' ? {} : { created: true as const })
  }
}

function assertMigrationFence(
  userDataPath: string,
  target: SshTarget | undefined,
  environmentId: string,
  name: string
): void {
  const fence = target ? resolveKingudMigrationFence(userDataPath, target) : null
  if (
    fence?.state !== 'fenced' ||
    fence.cutover.destinationEnvironmentId !== environmentId ||
    fence.cutover.destinationName !== name
  ) {
    throw new Error('kingud_migration_fence_required')
  }
}
