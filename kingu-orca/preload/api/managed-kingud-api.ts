/** Managed kingud servers over SSH; desktop-only, so web clients leave it undefined. */
import { ipcRenderer } from 'electron'
import type {
  KingudDeltaMovePreview,
  KingudDeltaMoveResult,
  KingudManagedCancelStopResult,
  KingudManagedConversionResult,
  KingudManagedDeployResult,
  KingudManagedForgetResult,
  KingudManagedPendingMigrationRow,
  KingudManagedRecoveryResult,
  KingudManagedRollbackResult,
  KingudManagedRuntimeStatus,
  KingudManagedStopResult
} from '../../shared/kingud-managed-runtime'
import type { PublicKnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type {
  RuntimeSshAccessLinkRequest,
  RuntimeSshAccessUnlinkRequest
} from '../../shared/runtime-ssh-access'

export type ManagedKingudPreloadApi = {
  deploy: (args: {
    name: string
    sshTargetId: string
    force?: boolean
  }) => Promise<KingudManagedDeployResult>
  getStatus: (args: { selector: string }) => Promise<KingudManagedRuntimeStatus>
  update: (args: { selector: string; force?: boolean }) => Promise<KingudManagedDeployResult>
  rollback: (args: { selector: string }) => Promise<KingudManagedRollbackResult>
  recover: (args: {
    selector: string
    /** Restore the snapshot over state a rejected build changed; see KINGUD_RECOVERY_CHANGED_STATE_CODE. */
    acceptChangedState?: boolean
  }) => Promise<KingudManagedRecoveryResult>
  stop: (args: { selector: string }) => Promise<KingudManagedStopResult>
  cancelStop: (args: { selector: string }) => Promise<KingudManagedCancelStopResult>
  forget: (args: { selector: string }) => Promise<KingudManagedForgetResult>
  linkSshAccess: (args: RuntimeSshAccessLinkRequest) => Promise<PublicKnownRuntimeEnvironment>
  unlinkSshAccess: (args: RuntimeSshAccessUnlinkRequest) => Promise<PublicKnownRuntimeEnvironment>
  convertSshHost: (args: {
    sshTargetId: string
    name: string
  }) => Promise<KingudManagedConversionResult>
  listPendingMigrations: () => Promise<KingudManagedPendingMigrationRow[]>
  previewDeltaMove: (args: { sshTargetId: string }) => Promise<KingudDeltaMovePreview>
  moveDelta: (args: { sshTargetId: string }) => Promise<KingudDeltaMoveResult>
  keepServerVersion: (args: { sshTargetId: string }) => Promise<void>
  /** "Move anyway": the next connect leaves what can't move on this desktop. */
  allowMoveLeavingBehind: (args: { sshTargetId: string }) => Promise<void>
}

export const managedKingudApi: ManagedKingudPreloadApi = {
  deploy: (args) => ipcRenderer.invoke('runtimeEnvironments:deployKingud', args),
  getStatus: (args) => ipcRenderer.invoke('runtimeEnvironments:getKingudStatus', args),
  update: (args) => ipcRenderer.invoke('runtimeEnvironments:updateKingud', args),
  rollback: (args) => ipcRenderer.invoke('runtimeEnvironments:rollbackKingud', args),
  recover: (args) => ipcRenderer.invoke('runtimeEnvironments:recoverKingud', args),
  stop: (args) => ipcRenderer.invoke('runtimeEnvironments:stopKingud', args),
  cancelStop: (args) => ipcRenderer.invoke('runtimeEnvironments:cancelKingudStop', args),
  forget: (args) => ipcRenderer.invoke('runtimeEnvironments:forgetKingud', args),
  linkSshAccess: (args) => ipcRenderer.invoke('runtimeEnvironments:linkSshAccess', args),
  unlinkSshAccess: (args) => ipcRenderer.invoke('runtimeEnvironments:unlinkSshAccess', args),
  convertSshHost: (args) =>
    ipcRenderer.invoke('runtimeEnvironments:convertSshHostToManagedKingud', args),
  listPendingMigrations: () =>
    ipcRenderer.invoke('runtimeEnvironments:listPendingKingudMigrations'),
  previewDeltaMove: (args) =>
    ipcRenderer.invoke('runtimeEnvironments:previewKingudDeltaMove', args),
  moveDelta: (args) => ipcRenderer.invoke('runtimeEnvironments:moveKingudDelta', args),
  keepServerVersion: (args) =>
    ipcRenderer.invoke('runtimeEnvironments:keepKingudServerVersion', args),
  allowMoveLeavingBehind: (args) =>
    ipcRenderer.invoke('runtimeEnvironments:allowKingudMoveLeavingBehind', args)
}
