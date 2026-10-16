import { ipcMain } from 'electron'
import { registerManagedServerActions } from '../runtime/managed-server-actions-registry'
import {
  createManagedKingudActions,
  type ManagedKingudActionOptions
} from './managed-kingud-actions'
import { requiredString } from './kingud-runtime-lifecycle-handlers'

export function registerKingudRuntimeMaintenanceHandlers(
  options: ManagedKingudActionOptions
): void {
  const actions = createManagedKingudActions(options)
  // Why: the CLI reaches these same actions over runtime RPC (managedServer.*).
  registerManagedServerActions(actions)
  ipcMain.handle(
    'runtimeEnvironments:updateKingud',
    async (_event, args: { selector: string; force?: boolean }) =>
      actions.update(requiredString(args?.selector, 'Server'), args?.force === true)
  )
  ipcMain.handle('runtimeEnvironments:rollbackKingud', async (_event, args: { selector: string }) =>
    actions.rollback(requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle(
    'runtimeEnvironments:recoverKingud',
    async (_event, args: { selector: string; acceptChangedState?: boolean }) =>
      actions.recover(requiredString(args?.selector, 'Server'), args?.acceptChangedState === true)
  )
  ipcMain.handle('runtimeEnvironments:stopKingud', async (_event, args: { selector: string }) =>
    actions.stop(requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle(
    'runtimeEnvironments:cancelKingudStop',
    async (_event, args: { selector: string }) =>
      actions.cancelStop(requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle('runtimeEnvironments:forgetKingud', async (_event, args: { selector: string }) =>
    actions.forget(requiredString(args?.selector, 'Server'))
  )
}
