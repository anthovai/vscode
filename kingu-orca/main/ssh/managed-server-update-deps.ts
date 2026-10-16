/** The live update-check collaborators, shared by the connect decision and the tunnel restore. */
import { getAppEnvironment } from '../../shared/app-environment'
import type { ManagedServerUpdateDeps } from './managed-server-update-check'
import { autoUpdateManagedKingudEnvironment } from './kingud-managed-auto-update'
import { requireManagedKingudTargetStore } from './kingud-managed-runtime-context'

export function managedServerUpdateDeps(userDataPath: string): ManagedServerUpdateDeps {
  const registry = requireManagedKingudTargetStore()
  const appVersion = getAppEnvironment().getVersion()
  return {
    autoUpdate: (environmentId, options) =>
      autoUpdateManagedKingudEnvironment(userDataPath, { environmentId, appVersion, ...options }),
    recordedUpdateFailure: (target) =>
      target.managedServerUpdateFailure?.appVersion === appVersion
        ? target.managedServerUpdateFailure.reason
        : null,
    recordUpdateFailure: (target, reason) => {
      registry.updateTarget(target.id, { managedServerUpdateFailure: { reason, appVersion } })
    },
    clearUpdateFailure: (target) => {
      registry.updateTarget(target.id, { managedServerUpdateFailure: undefined })
    }
  }
}
