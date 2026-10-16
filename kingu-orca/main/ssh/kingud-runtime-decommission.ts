/**
 * Stopping a managed kingud and unlinking it, on T6-4's journaled decommission. The server stays
 * linked — its SSH claim, tunnel and deployment record — unless the host proves kingud exited.
 */
import type {
  KingudManagedCancelStopResult,
  KingudManagedForgetResult,
  KingudManagedStopResult
} from '../../shared/kingud-managed-runtime'
import type { KingudDaemonRetirementVerdict } from '../../shared/kingud-stop-request'
import { removeManagedKingudEnvironment } from '../../shared/runtime-environment-managed-kingud-store'
import type {
  KnownRuntimeEnvironment,
  KingudSshDeploymentLink
} from '../../shared/runtime-environments'
import { recoverInterruptedKingudActivation } from './kingud-activation-recovery'
import { withStaleKingudActivationRecoveryLock } from './kingud-activation-lock'
import { readKingudActivationTransaction } from './kingud-activation-transaction-store'
import { reconcileKingudDecommission } from './kingud-decommission-recovery'
import { cancelRemoteKingudManagedStop } from './kingud-managed-remote-stop'
import {
  managedKingudSlot,
  requireManagedKingudInfrastructure,
  resolveLinkedKingudContext
} from './kingud-managed-runtime-context'
import { closeKingudManagedTunnel, ensureKingudManagedTunnel } from './kingud-managed-tunnel'
import { clearManagedKingudUpdateDeferral } from './kingud-managed-update-deferrals'
import { removeKingudMigrationJournalsForDestination } from './kingud-migration-cutover-journal'
import { decommissionRemoteKingud } from './kingud-remote-decommission'
import { withManagedKingudLifecycle } from './kingud-runtime-maintenance'
import { collectManagedTerminalCensus } from './kingud-terminal-census-client'
import { RemoteInstallLockBusyError } from './ssh-relay-install-lock'

export type ManagedKingudStopPolicy = {
  isActiveEnvironment: (environmentId: string) => boolean
  /** Invalidates the server's transport and retires its client-side state once it is unlinked. */
  retireLocalState: (environmentId: string) => Promise<void> | void
}

type Refusal = Extract<KingudManagedStopResult, { outcome: 'refused' }>
type Stopped = { version: string | null; retirement: KingudDaemonRetirementVerdict | null }

function refuse(verdict: Refusal['verdict'], code: string, reason: string): Refusal {
  return { outcome: 'refused', verdict, code, reason }
}

export function stopManagedKingudEnvironment(
  userDataPath: string,
  args: { selector: string; signal?: AbortSignal },
  policy: ManagedKingudStopPolicy
): Promise<KingudManagedStopResult> {
  return withManagedKingudLifecycle(userDataPath, args.selector, async (managed) => {
    const { environment, deployment } = managed
    if (policy.isActiveEnvironment(environment.id)) {
      return refuse(
        'live',
        'kingud_stop_active_environment',
        'This server is the default host for new projects. Choose another one in Advanced before stopping it.'
      )
    }
    const stopped = await stopRemote(userDataPath, environment, deployment, args.signal)
    if ('outcome' in stopped) {
      return stopped
    }
    await unlinkEnvironmentLocally(userDataPath, environment, deployment, policy)
    return {
      outcome: 'unlinked',
      verdict: 'exited',
      environmentId: environment.id,
      sshTargetId: deployment.sshTargetId,
      stoppedVersion: stopped.version,
      retirement: stopped.retirement
    }
  })
}

/**
 * Stop's local half alone, for a host that can no longer answer (P1-E). Nothing on the host is
 * touched or assumed: a server still running there keeps running, and a later connect relinks it.
 */
export function forgetManagedKingudEnvironment(
  userDataPath: string,
  args: { selector: string },
  policy: ManagedKingudStopPolicy
): Promise<KingudManagedForgetResult> {
  return withManagedKingudLifecycle(userDataPath, args.selector, async (managed) => {
    const { environment, deployment } = managed
    if (policy.isActiveEnvironment(environment.id)) {
      return refuse(
        'live',
        'kingud_forget_active_environment',
        'This server is the default host for new projects. Choose another one in Advanced before forgetting it.'
      )
    }
    await unlinkEnvironmentLocally(userDataPath, environment, deployment, policy)
    return {
      outcome: 'forgotten',
      verdict: 'unverifiable',
      environmentId: environment.id,
      sshTargetId: deployment.sshTargetId
    }
  })
}

/** Proven exit, or the refusal that keeps the server linked. */
async function stopRemote(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  deployment: KingudSshDeploymentLink,
  signal?: AbortSignal,
  retried = false
): Promise<Stopped | Refusal> {
  const context = await resolveLinkedKingudContext(environment, deployment, signal)
  const slot = managedKingudSlot(context, deployment.remotePort, signal)
  const transaction = await readKingudActivationTransaction(slot)
  if (transaction?.operation === 'decommission') {
    // An earlier stop was interrupted: its journal decides, so finish exactly that one.
    const recovered = await recoverInterruptedKingudActivation(slot)
    if (recovered.outcome === 'recovered' && recovered.activeVersion === null) {
      return { version: transaction.activeVersion, retirement: null }
    }
    if (recovered.outcome === 'refused') {
      return refuse(recovered.verdict, recovered.code, recovered.reason)
    }
    if (recovered.outcome === 'pending') {
      return refuse('unverifiable', recovered.code, recovered.reason)
    }
    // Another run settled the journal first; start over from what it left, never assume live.
    if (recovered.outcome === 'none') {
      return retried
        ? refuse(
            'unverifiable',
            'kingud_stop_journal_changed',
            'Another run on this server changed its stop while this one waited. Refresh and retry.'
          )
        : stopRemote(userDataPath, environment, deployment, signal, true)
    }
    return refuse(
      'live',
      'kingud_stop_withdrawn',
      'The interrupted stop was withdrawn and the server keeps serving. Stop it again.'
    )
  }
  if (transaction) {
    return refuse(
      'unverifiable',
      'kingud_activation_recovery_required',
      'An earlier update on this server was interrupted. Recover it before stopping.'
    )
  }
  const record = context.activationRecord
  if (!record.active) {
    // Only a proven exit (or a deploy that never activated) leaves the record without a version.
    return { version: null, retirement: null }
  }
  const census = await collectManagedTerminalCensus(userDataPath, environment, record)
  const result = await decommissionRemoteKingud({ ...slot, record, census })
  if (result.outcome === 'refused') {
    return refuse(result.verdict, result.code, result.reason)
  }
  return { version: result.version, retirement: result.retirement }
}

async function unlinkEnvironmentLocally(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  deployment: KingudSshDeploymentLink,
  policy: ManagedKingudStopPolicy
): Promise<void> {
  // Environment first: a crash before the claim is released leaves a hidden target to resume,
  // never a linked server whose SSH target was already handed back.
  removeManagedKingudEnvironment(userDataPath, environment.id)
  await policy.retireLocalState(environment.id)
  await closeKingudManagedTunnel(environment.id)
  const { claims } = requireManagedKingudInfrastructure()
  claims.release(deployment.sshTargetId, environment.id)
  clearManagedKingudUpdateDeferral(environment.id)
  await claims.flush()
  // After the fence: a crash between leaves a stale journal a later conversion clears.
  removeKingudMigrationJournalsForDestination(userDataPath, deployment.sshTargetId, environment.id)
}

/** Withdraws a stop kingud has not acted on yet; the server then keeps serving. */
export function cancelManagedKingudStop(
  userDataPath: string,
  args: { selector: string; signal?: AbortSignal }
): Promise<KingudManagedCancelStopResult> {
  return withManagedKingudLifecycle(userDataPath, args.selector, async (managed) => {
    const { environment, deployment } = managed
    const context = await resolveLinkedKingudContext(environment, deployment, args.signal)
    const slot = managedKingudSlot(context, deployment.remotePort, args.signal)
    let result: KingudManagedCancelStopResult
    try {
      result = await withStaleKingudActivationRecoveryLock(slot, async (lock) => {
        const transaction = await readKingudActivationTransaction(slot)
        if (transaction?.operation !== 'decommission') {
          if (transaction) {
            lock.retain()
          }
          return { outcome: 'none' }
        }
        if (transaction.phase === 'process-exited') {
          lock.retain()
          return { outcome: 'already-stopped' }
        }
        if (transaction.request) {
          const cancellation = await cancelRemoteKingudManagedStop(slot, transaction.request)
          if (cancellation.outcome !== 'canceled') {
            lock.retain()
            return {
              outcome: 'refused',
              verdict: 'live',
              code: 'kingud_stop_already_dispatched',
              reason:
                'kingud already acted on the stop and is shutting down; it cannot be canceled.'
            }
          }
        }
        const kept = await reconcileKingudDecommission(slot, {
          action: 'keep-serving',
          version: transaction.activeVersion
        })
        if (kept.outcome !== 'recovered' || !kept.activeVersion) {
          lock.retain()
          return {
            outcome: 'refused',
            verdict: 'unverifiable',
            code: 'kingud_stop_cancel_unverifiable',
            reason: 'The stop was withdrawn but the server could not be shown to be serving.'
          }
        }
        return { outcome: 'canceled', activeVersion: kept.activeVersion }
      })
    } catch (error) {
      if (error instanceof RemoteInstallLockBusyError) {
        return {
          outcome: 'refused',
          verdict: 'unverifiable',
          code: 'kingud_stop_still_running',
          reason: 'A stop on this server may still be running. Retry after it settles.'
        }
      }
      throw error
    }
    if (result.outcome === 'canceled') {
      await ensureKingudManagedTunnel(userDataPath, environment.id)
    }
    return result
  })
}
