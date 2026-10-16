import { ipcMain } from 'electron'
import type { KingudManagedRuntimeStatus } from '../../shared/kingud-managed-runtime'
import {
  createManagedKingudEnvironment,
  getManagedKingudRuntimeStatus
} from '../ssh/kingud-runtime-lifecycle'
import { registerKingudSshProvisioningHandlers } from './kingud-ssh-provisioning-handlers'

export function registerKingudRuntimeLifecycleHandlers(options: {
  getUserDataPath: () => string
}): void {
  registerKingudSshProvisioningHandlers(options.getUserDataPath)
  ipcMain.handle(
    'runtimeEnvironments:deployKingud',
    async (_event, args: { name: string; sshTargetId: string; force?: boolean }) =>
      createManagedKingudEnvironment(options.getUserDataPath(), {
        name: requiredString(args?.name, 'Server name'),
        sshTargetId: requiredString(args?.sshTargetId, 'SSH target'),
        force: args?.force === true
      })
  )
  ipcMain.handle(
    'runtimeEnvironments:getKingudStatus',
    (_event, args: { selector: string }): Promise<KingudManagedRuntimeStatus> =>
      getManagedKingudRuntimeStatus(
        options.getUserDataPath(),
        requiredString(args?.selector, 'Server')
      )
  )
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value.trim()
}
