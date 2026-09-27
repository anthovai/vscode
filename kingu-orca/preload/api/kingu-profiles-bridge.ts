import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import {
  KINGU_PROFILE_AUTH_STATUS_CHANGED_CHANNEL,
  type KinguProfileListResult,
  type SwitchKinguProfileResult,
  type TransferKinguProfileProjectResult
} from '../../shared/kingu-profiles'
import { prepareAndInvokeAppRestart } from '../renderer-restart-wiring'
import { awaitBeforeUnloadCheckpoint } from '../preload-runtime-support'

export const kinguProfilesApi = {
  list: () => ipcRenderer.invoke('kinguProfiles:list'),
  authStatus: () => ipcRenderer.invoke('kinguProfiles:authStatus'),
  onAuthStatusChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(KINGU_PROFILE_AUTH_STATUS_CHANGED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(KINGU_PROFILE_AUTH_STATUS_CHANGED_CHANNEL, listener)
  },
  createLocal: (args) => ipcRenderer.invoke('kinguProfiles:createLocal', args),
  createCloudLinked: (args) => ipcRenderer.invoke('kinguProfiles:createCloudLinked', args),
  switchProfile: (args) =>
    prepareAndInvokeAppRestart(
      window,
      (): Promise<SwitchKinguProfileResult> => ipcRenderer.invoke('kinguProfiles:switch', args),
      awaitBeforeUnloadCheckpoint,
      (result) => result.status === 'relaunching'
    ),
  transferProject: async (args) => {
    const invoke = (): Promise<TransferKinguProfileProjectResult> =>
      ipcRenderer.invoke('kinguProfiles:transferProject', args)
    if (args.mode !== 'move') {
      return invoke()
    }
    const current: KinguProfileListResult = await ipcRenderer.invoke('kinguProfiles:list')
    if (args.sourceProfileId !== current.activeProfileId) {
      return invoke()
    }
    return prepareAndInvokeAppRestart(
      window,
      invoke,
      awaitBeforeUnloadCheckpoint,
      (result) => result.status === 'transferred' && result.willRelaunch === true
    )
  },
  findProjectProfiles: (args) => ipcRenderer.invoke('kinguProfiles:findProjectProfiles', args),
  connectCurrent: () => ipcRenderer.invoke('kinguProfiles:connectCurrent'),
  refreshAuth: () => ipcRenderer.invoke('kinguProfiles:refreshAuth'),
  signOutCurrent: () => ipcRenderer.invoke('kinguProfiles:signOutCurrent'),
  selectOrg: (args) => ipcRenderer.invoke('kinguProfiles:selectOrg', args),
  orgMembersList: (args) => ipcRenderer.invoke('kinguProfiles:orgMembersList', args),
  orgMemberInvite: (args) => ipcRenderer.invoke('kinguProfiles:orgMemberInvite', args),
  orgInviteRevoke: (args) => ipcRenderer.invoke('kinguProfiles:orgInviteRevoke', args),
  orgMemberChangeRole: (args) => ipcRenderer.invoke('kinguProfiles:orgMemberChangeRole', args),
  orgMemberRemove: (args) => ipcRenderer.invoke('kinguProfiles:orgMemberRemove', args)
} satisfies PreloadApi['kinguProfiles']
