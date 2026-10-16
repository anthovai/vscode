/** IPC for a host an older build changed after conversion: move its newer projects, or keep the server's. */
import { ipcMain } from 'electron'
import type {
  KingudDeltaMovePreview,
  KingudDeltaMoveResult
} from '../../shared/kingud-managed-runtime'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { requireManagedKingudInfrastructure } from '../ssh/kingud-managed-runtime-context'
import { ensureKingudManagedTunnel } from '../ssh/kingud-managed-tunnel'
import { keepKingudServerVersion, runKingudDeltaMove } from '../ssh/kingud-migration-delta-move'
import { planKingudDeltaMove } from '../ssh/kingud-migration-delta-plan'
import { censusHostRelayTerminalsFor } from '../ssh/ssh-host-relay-census-for-target'
import { kingudMigrationDestinationFor } from '../ssh/kingud-runtime-conversion-wiring'
import { requiredString } from './kingud-runtime-lifecycle-handlers'
import { publishResolvedChangedHostStatus } from './runtime-environment-managed-tunnel'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'

export function registerKingudDeltaMoveHandlers(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:previewKingudDeltaMove',
    (_event, args: { sshTargetId: string }): KingudDeltaMovePreview => {
      const { store, target } = requireChangedHost(args)
      const plan = planKingudDeltaMove(getUserDataPath(), store, target)
      const { sshTargetId, environmentId, added, notReflected, blockers } = plan
      return { sshTargetId, environmentId, added, notReflected, blockers }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:moveKingudDelta',
    async (_event, args: { sshTargetId: string }): Promise<KingudDeltaMoveResult> => {
      const userDataPath = getUserDataPath()
      const { store, claims, target } = requireChangedHost(args)
      const environment = listEnvironments(userDataPath).find(
        (entry) => entry.id === target.kingudFence?.environmentId
      )
      if (!environment) {
        throw new Error('The managed Kingu server for this host is no longer registered.')
      }
      const result = await runKingudDeltaMove({
        userDataPath,
        store,
        claims,
        target,
        environment,
        destination: kingudMigrationDestinationFor(environment),
        censusHost: censusHostRelayTerminalsFor(target),
        ensureTunnel: async () => {
          await ensureKingudManagedTunnel(userDataPath, environment.id)
        },
        runTargetLifecycle
      })
      if (result.outcome === 'moved') {
        publishResolvedChangedHostStatus(target, environment.id)
      }
      return result
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:keepKingudServerVersion',
    async (_event, args: { sshTargetId: string }): Promise<void> => {
      const { store, claims, target, environmentId } = requireChangedHost(args)
      await runTargetLifecycle(target.id, () =>
        keepKingudServerVersion({ userDataPath: getUserDataPath(), store, claims, target })
      )
      publishResolvedChangedHostStatus(target, environmentId)
    }
  )
}

function requireChangedHost(args: { sshTargetId: string } | undefined) {
  const sshTargetId = requiredString(args?.sshTargetId, 'SSH target')
  const { targetStore, claims } = requireManagedKingudInfrastructure()
  const store = targetStore.getKingudMigrationSource()
  const target = store.getSshTarget(sshTargetId)
  if (!target?.kingudFence?.sourceChangedAt) {
    throw new Error('This SSH host has no changes from an older Kingu to resolve.')
  }
  return { store, claims, target, environmentId: target.kingudFence.environmentId }
}
