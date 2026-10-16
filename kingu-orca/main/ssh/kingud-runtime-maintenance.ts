/**
 * Updating, rolling back and recovering a managed kingud, on T6-2's deploy, rollback and recovery.
 * Every step reads the terminal census through the server's tunnel first; an unanswered census
 * is unverifiable, never zero, so an update over live or uncounted terminals defers (D7).
 */
import { getAppEnvironment } from '../../shared/app-environment'
import { refreshManagedKingudPairing } from '../../shared/runtime-environment-managed-kingud-store'
import { assertRuntimeEnvironmentNotReconciling } from '../../shared/runtime-environment-reconciliation-record'
import {
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type {
  KingudManagedDeployResult,
  KingudManagedRecoveryResult,
  KingudManagedRollbackResult
} from '../../shared/kingud-managed-runtime'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import type { ServeReadiness } from '../server/serve-readiness'
import { recoverInterruptedKingudActivation } from './kingud-activation-recovery'
import { probeActiveKingudReadiness } from './kingud-active-readiness'
import { materializeKingudArtifact } from '../kingud/kingud-artifact-materializer'
import { CURRENT_KINGUD_DAEMON_PROTOCOL } from './kingud-daemon-protocol-crossing'
import { ensureKingudManagedTunnel, rebuildKingudManagedTunnel } from './kingud-managed-tunnel'
import { wakeAlreadyActiveKingud } from './kingud-already-active-wake'
import {
  clearManagedKingudUpdateDeferral,
  recordManagedKingudUpdateDeferral
} from './kingud-managed-update-deferrals'
import {
  isForceableKingudDeferral,
  managedKingudInstallDir,
  managedKingudSlot,
  probeManagedKingudReadiness,
  requireManagedKingudEnvironment,
  resolveLinkedKingudContext
} from './kingud-managed-runtime-context'
import type { KingudRemoteContext } from './kingud-remote-context'
import { readRemoteKingudBuildHash } from './kingud-remote-build-hash'
import { deployKingud, type KingudDeployOptions } from './kingud-remote-deploy'
import { KINGUD_ACTIVATION_POLICY_REFUSED_CODE } from './kingud-installed-activation'
import { pruneManagedKingudVersions } from './kingud-managed-version-gc'
import { rollbackKingud } from './kingud-remote-rollback'
import { collectManagedTerminalCensus } from './kingud-terminal-census-client'
import { findIncompleteManagedKingudMigration } from './kingud-managed-migration-status'
import { latestKingudMigrationInto } from './kingud-migration-rollback-mark'
import { tunneledKingudPairingCode } from './kingud-tunneled-pairing'

type LifecycleArgs = { selector: string; signal?: AbortSignal }

export function withManagedKingudLifecycle<T>(
  userDataPath: string,
  selector: string,
  run: (managed: ReturnType<typeof requireManagedKingudEnvironment>) => Promise<T>
): Promise<T> {
  const { environment, deployment } = requireManagedKingudEnvironment(userDataPath, selector)
  return runTargetLifecycle(deployment.sshTargetId, async () => {
    // Re-read under the queue: a reconciliation or stop may have won the race for it.
    const current = requireManagedKingudEnvironment(userDataPath, environment.id)
    assertRuntimeEnvironmentNotReconciling(current.environment)
    return run(current)
  })
}

function refreshPairing(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  readiness: ServeReadiness,
  localPort: number
): KnownRuntimeEnvironment {
  return refreshManagedKingudPairing(
    userDataPath,
    environment.id,
    tunneledKingudPairingCode(readiness, localPort)
  )
}

export function updateManagedKingudEnvironment(
  userDataPath: string,
  args: LifecycleArgs & { force?: boolean }
): Promise<KingudManagedDeployResult> {
  return withManagedKingudLifecycle(userDataPath, args.selector, async (managed) =>
    runManagedKingudUpdate(
      userDataPath,
      managed,
      await resolveLinkedKingudContext(managed.environment, managed.deployment, args.signal),
      args
    )
  )
}

/** The Managed servers update, run inside the target's lifecycle queue with a resolved context. */
export async function runManagedKingudUpdate(
  userDataPath: string,
  { environment, deployment }: ReturnType<typeof requireManagedKingudEnvironment>,
  context: KingudRemoteContext,
  args: {
    force?: boolean
    signal?: AbortSignal
    localKingudDir?: string
    admitRecord?: KingudDeployOptions['admitRecord']
  }
): Promise<KingudManagedDeployResult> {
  // Why release: finished automation shells would otherwise defer every update on a host with
  // schedules; the update restarts the server anyway.
  const census = await collectManagedTerminalCensus(
    userDataPath,
    environment,
    context.activationRecord,
    undefined,
    { releaseFinishedAutomationTerminals: true }
  )
  const localKingudDir =
    args.localKingudDir ??
    (await materializeKingudArtifact(context.serverTarget, { signal: args.signal }))
  const slot = managedKingudSlot(context, deployment.remotePort, args.signal)
  const result = await deployKingud({
    ...slot,
    localKingudDir,
    target: context.serverTarget,
    census,
    censusRecord: context.activationRecord,
    force: args.force,
    appVersion: getAppEnvironment().getVersion(),
    ...(args.admitRecord ? { admitRecord: args.admitRecord } : {})
  })
  if (result.outcome === 'installed-not-activated') {
    const deferral = {
      outcome: 'deferred' as const,
      candidateVersion: result.fullVersion,
      code: result.code,
      reason: result.reason,
      forceable: isForceableKingudDeferral(result.code)
    }
    // A policy refusal is a decision about this host, not an update waiting to be retried.
    if (result.code !== KINGUD_ACTIVATION_POLICY_REFUSED_CODE) {
      recordManagedKingudUpdateDeferral(environment.id, deferral)
    }
    return deferral
  }
  clearManagedKingudUpdateDeferral(environment.id)
  const started = result.outcome === 'already-active' && (await wakeAlreadyActiveKingud(slot))
  const readiness = await probeManagedKingudReadiness(
    context,
    localKingudDir,
    result.fullVersion,
    args.signal
  )
  await pruneManagedKingudVersions({
    slot,
    serverTarget: context.serverTarget,
    activeVersion: result.fullVersion,
    readiness
  })
  const updated = refreshPairing(userDataPath, environment, readiness, deployment.localPort)
  if (started) {
    // The started slot may have bound another port than the forward in use.
    await rebuildKingudManagedTunnel(userDataPath, environment.id)
  }
  return {
    outcome: result.outcome === 'already-active' ? 'already-current' : 'updated',
    environment: redactRuntimeEnvironment(updated),
    activeVersion: result.fullVersion
  }
}

export function rollbackManagedKingudEnvironment(
  userDataPath: string,
  args: LifecycleArgs
): Promise<KingudManagedRollbackResult> {
  return withManagedKingudLifecycle(
    userDataPath,
    args.selector,
    async ({ environment, deployment }) => {
      const context = await resolveLinkedKingudContext(environment, deployment, args.signal)
      const record = context.activationRecord
      const target = record.previous
      if (!target) {
        return {
          outcome: 'refused',
          code: 'kingud_rollback_no_target',
          reason: 'This server has no previous version to roll back to.'
        }
      }
      const crossing = migrationRollbackRefusal(userDataPath, environment, record.activatedAt)
      if (crossing) {
        return crossing
      }
      const census = await collectManagedTerminalCensus(
        userDataPath,
        environment,
        record,
        undefined,
        {
          releaseFinishedAutomationTerminals: true
        }
      )
      // Why idle only: this client cannot read the older build's daemon protocol, so it cannot show
      // that build would reach terminals that are still running.
      if (census.liveSessions !== 0) {
        return {
          outcome: 'refused',
          code:
            census.liveSessions === null
              ? 'kingud_rollback_census_unavailable'
              : 'kingud_rollback_terminals_running',
          reason:
            census.liveSessions === null
              ? 'The server did not answer how many terminals it runs. Retry when it answers.'
              : 'Close the terminals running on this server before rolling it back.'
        }
      }
      const slot = managedKingudSlot(context, deployment.remotePort, args.signal)
      const targetDir = managedKingudInstallDir(context, target)
      const targetBuildHash = await readRemoteKingudBuildHash(slot, targetDir)
      const result = await rollbackKingud({
        ...slot,
        record,
        census,
        targetBuildHash,
        targetDaemonProtocol: CURRENT_KINGUD_DAEMON_PROTOCOL
      })
      if (result.outcome !== 'rolled-back') {
        return result
      }
      const readiness = await probeActiveKingudReadiness(
        { ...slot, remoteInstallDir: targetDir },
        { buildHash: targetBuildHash, fullVersion: result.target }
      )
      const updated = refreshPairing(userDataPath, environment, readiness, deployment.localPort)
      return {
        outcome: 'rolled-back',
        environment: redactRuntimeEnvironment(updated),
        activeVersion: result.target,
        discarded: result.discarded
      }
    }
  )
}

/** Finishes or undoes an interrupted activation, rollback or decommission on the host. */
export function recoverManagedKingudEnvironment(
  userDataPath: string,
  args: LifecycleArgs & { acceptChangedState?: boolean }
): Promise<KingudManagedRecoveryResult> {
  return withManagedKingudLifecycle(
    userDataPath,
    args.selector,
    async ({ environment, deployment }) => {
      const context = await resolveLinkedKingudContext(environment, deployment, args.signal)
      const result = await recoverInterruptedKingudActivation({
        ...managedKingudSlot(context, deployment.remotePort, args.signal),
        acceptChangedState: args.acceptChangedState === true
      })
      if (result.outcome !== 'recovered') {
        return result
      }
      const updated = result.readiness
        ? refreshPairing(userDataPath, environment, result.readiness, deployment.localPort)
        : environment
      if (result.activeVersion) {
        await ensureKingudManagedTunnel(userDataPath, environment.id)
      }
      return {
        outcome: 'recovered',
        resolution: result.resolution,
        activeVersion: result.activeVersion,
        environment: redactRuntimeEnvironment(updated)
      }
    }
  )
}

/**
 * A rollback restores the snapshot taken when the current version activated. If a migration
 * began after that, the snapshot predates the imported catalog and restoring it would drop it.
 */
function migrationRollbackRefusal(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  activatedAt: string | null
): KingudManagedRollbackResult | null {
  if (findIncompleteManagedKingudMigration(userDataPath, environment.id)) {
    return {
      outcome: 'refused',
      code: 'kingud_rollback_migration_in_progress',
      reason: 'A migration into this server is still running. Finish it before rolling back.'
    }
  }
  const migratedAt = latestKingudMigrationInto(userDataPath, environment)
  if (migratedAt && (activatedAt === null || Date.parse(activatedAt) < Date.parse(migratedAt))) {
    return {
      outcome: 'refused',
      code: 'kingud_rollback_crosses_migration',
      reason:
        "The previous version's state predates the projects migrated onto this server; " +
        'rolling back would lose them. Deploy forward instead.'
    }
  }
  return null
}
