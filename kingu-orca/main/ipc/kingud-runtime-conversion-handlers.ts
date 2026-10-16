import { ipcMain } from 'electron'
import type {
  KingudManagedConversionResult,
  KingudManagedPendingMigrationRow
} from '../../shared/kingud-managed-runtime'
import { listPendingManagedKingudMigrations } from '../ssh/kingud-managed-migration-status'
import { convertSshTargetToManagedKingud } from '../ssh/kingud-runtime-conversion'
import { conversionCollaborators } from '../ssh/kingud-runtime-conversion-wiring'
import { requiredString } from './kingud-runtime-lifecycle-handlers'

export function registerKingudRuntimeConversionHandlers(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:convertSshHostToManagedKingud',
    (
      _event,
      args: { sshTargetId: string; name: string }
    ): Promise<KingudManagedConversionResult> => {
      return convertSshTargetToManagedKingud(getUserDataPath(), {
        sshTargetId: requiredString(args?.sshTargetId, 'SSH target'),
        name: requiredString(args?.name, 'Server name'),
        ...conversionCollaborators()
      })
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:listPendingKingudMigrations',
    (): KingudManagedPendingMigrationRow[] => listPendingManagedKingudMigrations(getUserDataPath())
  )
}
