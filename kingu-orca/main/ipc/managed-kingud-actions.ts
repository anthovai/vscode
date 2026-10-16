/** The managed-server actions behind both the Managed servers settings and runtime RPC. */
import {
  cancelManagedKingudStop,
  forgetManagedKingudEnvironment,
  getManagedKingudRuntimeStatus,
  recoverManagedKingudEnvironment,
  rollbackManagedKingudEnvironment,
  stopManagedKingudEnvironment,
  updateManagedKingudEnvironment
} from '../ssh/kingud-runtime-lifecycle'
import { getKingudSshDeployment } from '../../shared/runtime-environments'
import type { ManagedServerActions } from '../runtime/managed-server-actions-registry'
import {
  retireRemovedRuntimeEnvironment,
  type RemovedServerStore
} from './runtime-environment-removal-cleanup'

export type ManagedKingudActionOptions = {
  getUserDataPath: () => string
  getActiveEnvironmentId: () => string | null | undefined
  invalidateTransport: (environmentId: string) => Promise<void> | void
  /** Drops the SSH host's stale update/serving notes once an update verified its server. */
  clearHostServerNotes: (sshTargetId: string, environmentId: string) => void
  /** Drops the SSH host's stale managed-server state once its server is unlinked. */
  clearHostServerStatus: (sshTargetId: string) => void
  /** Holds what an unlinked server leaves in the profile. */
  store: RemovedServerStore
}

export function createManagedKingudActions(
  options: ManagedKingudActionOptions
): ManagedServerActions {
  const userDataPath = options.getUserDataPath
  const unlinkPolicy = {
    isActiveEnvironment: (environmentId: string) =>
      options.getActiveEnvironmentId() === environmentId,
    retireLocalState: (environmentId: string) =>
      retireRemovedRuntimeEnvironment(environmentId, options.invalidateTransport, options.store)
  }
  return {
    status: (selector) => getManagedKingudRuntimeStatus(userDataPath(), selector),
    update: async (selector, force) => {
      const result = await updateManagedKingudEnvironment(userDataPath(), { selector, force })
      // Why: a restarted kingud drops the old connection; reconnect on the new one.
      if (result.outcome === 'updated') {
        await options.invalidateTransport(result.environment.id)
      }
      if (result.outcome !== 'deferred') {
        const targetId = getKingudSshDeployment(result.environment)?.sshTargetId
        if (targetId) {
          options.clearHostServerNotes(targetId, result.environment.id)
        }
      }
      return result
    },
    rollback: async (selector) => {
      const result = await rollbackManagedKingudEnvironment(userDataPath(), { selector })
      if (result.outcome === 'rolled-back') {
        await options.invalidateTransport(result.environment.id)
      }
      return result
    },
    recover: async (selector, acceptChangedState) => {
      const result = await recoverManagedKingudEnvironment(userDataPath(), {
        selector,
        acceptChangedState: acceptChangedState === true
      })
      if (result.outcome === 'recovered' && result.activeVersion) {
        await options.invalidateTransport(result.environment.id)
      }
      return result
    },
    stop: async (selector) => {
      const result = await stopManagedKingudEnvironment(userDataPath(), { selector }, unlinkPolicy)
      if (result.outcome === 'unlinked') {
        options.clearHostServerStatus(result.sshTargetId)
      }
      return result
    },
    cancelStop: (selector) => cancelManagedKingudStop(userDataPath(), { selector }),
    forget: async (selector) => {
      const result = await forgetManagedKingudEnvironment(
        userDataPath(),
        { selector },
        unlinkPolicy
      )
      if (result.outcome === 'forgotten') {
        options.clearHostServerStatus(result.sshTargetId)
      }
      return result
    }
  }
}
