import { ipcMain } from 'electron'
import type { KingudSshProvisioningRequest } from '../../shared/kingud-ssh-provisioning'
import {
  createKingudSshHost,
  listPendingKingudSshProvisioning,
  resumeKingudSshHost
} from '../ssh/kingud-ssh-provisioning'

export function registerKingudSshProvisioningHandlers(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:createKingudSshHost',
    (_event, args: KingudSshProvisioningRequest) => createKingudSshHost(getUserDataPath(), args)
  )
  ipcMain.handle('runtimeEnvironments:resumeKingudSshHost', (_event, args: { requestId: string }) =>
    resumeKingudSshHost(getUserDataPath(), args?.requestId)
  )
  ipcMain.handle('runtimeEnvironments:listPendingKingudSshProvisioning', () =>
    listPendingKingudSshProvisioning(getUserDataPath())
  )
}
