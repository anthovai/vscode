import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import { relaunchApp, type AppRelaunchReason } from '../app-relaunch'
import type {
  CreateLocalKinguProfileArgs,
  CreateLocalKinguProfileResult,
  CreateCloudLinkedKinguProfileArgs,
  CreateCloudLinkedKinguProfileResult,
  FindKinguProfileProjectsByPathArgs,
  FindKinguProfileProjectsByPathResult,
  KinguProfileListResult,
  RefreshCurrentKinguProfileAuthResult,
  SwitchKinguProfileArgs,
  SwitchKinguProfileResult,
  TransferKinguProfileProjectArgs,
  TransferKinguProfileProjectResult,
  ConnectCurrentKinguProfileResult,
  KinguProfileAuthStatus,
  SelectKinguProfileOrgArgs,
  SelectKinguProfileOrgResult,
  SignOutCurrentKinguProfileResult
} from '../../shared/kingu-profiles'
import {
  createLocalKinguProfile,
  getKinguProfileListState,
  seedNewKinguProfileTelemetryConsent,
  setActiveKinguProfile
} from '../kingu-profiles/profile-index-store'
import {
  cloudSessionIdentity,
  recordCloudSessionIdentityMutation
} from '../kingu-profiles/profile-cloud-session-mutation'
import { getProfileUserDataPath } from '../kingu-profiles/profile-storage-paths'
import { isMultiProfileUiEnabled } from '../kingu-profiles/profile-ui-scope'
import { transferKinguProfileProject } from '../kingu-profiles/profile-project-transfer'
import { findKinguProfileProjectsByPath } from '../kingu-profiles/profile-project-presence'
import { flushActiveProfileBeforeFileMutation } from '../kingu-profiles/profile-persistence-deadline'
import { normalizeExecutionHostId } from '../../shared/execution-host'
import {
  createCloudLinkedKinguProfile,
  connectCurrentKinguProfile,
  getCurrentKinguProfileAuthStatus,
  refreshCurrentKinguProfileAuth,
  selectCurrentKinguProfileOrg,
  signOutCurrentKinguProfile
} from '../kingu-profiles/profile-cloud-service'
import { registerKinguProfileOrgMemberHandlers } from './kingu-profile-org-members-handlers'
import { onKinguCloudSessionInvalidated } from '../kingu-profiles/profile-cloud-session-invalidation'
import { broadcastKinguProfileAuthStatusChanged } from './kingu-profile-auth-status-broadcast'

type RegisterKinguProfileHandlersOptions = {
  onBeforeRelaunch?: () => void | Promise<void>
  onAuthMutation?: () => void
  onBeforeSignOut?: () => void
}

function profileIdFromArgs(args: unknown): string {
  if (
    !args ||
    typeof args !== 'object' ||
    typeof (args as SwitchKinguProfileArgs).profileId !== 'string'
  ) {
    throw new Error('invalid_kingu_profile_id')
  }
  const profileId = (args as SwitchKinguProfileArgs).profileId.trim()
  if (!profileId) {
    throw new Error('invalid_kingu_profile_id')
  }
  return profileId
}

function transferProjectArgsFromUnknown(args: unknown): TransferKinguProfileProjectArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_kingu_profile_project_transfer')
  }
  const candidate = args as TransferKinguProfileProjectArgs
  const sourceProfileId = candidate.sourceProfileId?.trim()
  const targetProfileId = candidate.targetProfileId?.trim()
  const repoId = candidate.repoId?.trim()
  const mode = candidate.mode
  if (!sourceProfileId || !targetProfileId || !repoId || (mode !== 'move' && mode !== 'copy')) {
    throw new Error('invalid_kingu_profile_project_transfer')
  }
  return {
    sourceProfileId,
    targetProfileId,
    repoId,
    mode
  }
}

function findProjectsByPathArgsFromUnknown(args: unknown): FindKinguProfileProjectsByPathArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_kingu_profile_project_path')
  }
  const candidate = args as FindKinguProfileProjectsByPathArgs
  const path = typeof candidate.path === 'string' ? candidate.path.trim() : ''
  if (!path) {
    throw new Error('invalid_kingu_profile_project_path')
  }
  let executionHostId: FindKinguProfileProjectsByPathArgs['executionHostId'] = null
  if (candidate.executionHostId !== null && candidate.executionHostId !== undefined) {
    if (typeof candidate.executionHostId !== 'string') {
      throw new Error('invalid_kingu_profile_project_path')
    }
    executionHostId = normalizeExecutionHostId(candidate.executionHostId)
    if (!executionHostId) {
      throw new Error('invalid_kingu_profile_project_path')
    }
  }
  return {
    path,
    connectionId:
      typeof candidate.connectionId === 'string' ? candidate.connectionId.trim() || null : null,
    executionHostId,
    excludeProfileId:
      typeof candidate.excludeProfileId === 'string'
        ? candidate.excludeProfileId.trim() || null
        : null
  }
}

function orgIdFromUnknown(args: unknown): string {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_kingu_profile_org_selection')
  }
  const orgId = (args as SelectKinguProfileOrgArgs).orgId?.trim()
  if (!orgId) {
    throw new Error('invalid_kingu_profile_org_selection')
  }
  return orgId
}

function createCloudLinkedProfileArgsFromUnknown(args: unknown): CreateCloudLinkedKinguProfileArgs {
  if (!args || typeof args !== 'object') {
    return {}
  }
  const candidate = args as CreateCloudLinkedKinguProfileArgs
  const orgId = typeof candidate.orgId === 'string' ? candidate.orgId.trim() : undefined
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : undefined
  return {
    ...(orgId ? { orgId } : {}),
    ...(name ? { name } : {})
  }
}

async function runBeforeProfileRelaunch(
  onBeforeRelaunch?: () => void | Promise<void>
): Promise<void> {
  try {
    await onBeforeRelaunch?.()
  } catch (error) {
    console.warn(
      '[kingu-profiles] Pre-relaunch cleanup failed; continuing profile switch:',
      error instanceof Error ? error.name : typeof error
    )
  }
}

function scheduleProfileRelaunch(reason: Extract<AppRelaunchReason, `profile-${string}`>): void {
  setTimeout(() => {
    relaunchApp(reason)
    // Why: app.quit() (not app.exit) so before-quit/will-quit still run —
    // renderer scrollback capture, PTY kill, stats flush, and daemon final
    // checkpoints must not be skipped on a profile switch.
    app.quit()
  }, 150)
}

export function registerKinguProfileHandlers(
  store: Store,
  options: RegisterKinguProfileHandlersOptions = {}
): void {
  ipcMain.handle('kinguProfiles:list', (): KinguProfileListResult => ({
    ...getKinguProfileListState(),
    multiProfileUi: isMultiProfileUiEnabled()
  }))

  ipcMain.handle('kinguProfiles:authStatus', (): KinguProfileAuthStatus =>
    getCurrentKinguProfileAuthStatus(getProfileUserDataPath())
  )

  // Why: a background refresh can revoke the session with no renderer request in
  // flight, so push the change instead of waiting for the next pane to ask.
  // Why not options.onAuthMutation: that hook drives the relay coordinator, which
  // is the caller that just failed the refresh — re-entering it here would be a loop.
  onKinguCloudSessionInvalidated(broadcastKinguProfileAuthStatusChanged)

  ipcMain.handle(
    'kinguProfiles:createLocal',
    (_event, args?: CreateLocalKinguProfileArgs): CreateLocalKinguProfileResult => {
      const result = createLocalKinguProfile(args)
      seedNewKinguProfileTelemetryConsent(result.profile.id, store.getSettings().telemetry)
      return result
    }
  )

  ipcMain.handle(
    'kinguProfiles:switch',
    async (_event, args: SwitchKinguProfileArgs): Promise<SwitchKinguProfileResult> => {
      const profileId = profileIdFromArgs(args)
      const current = getKinguProfileListState()
      if (profileId === current.activeProfileId) {
        return { status: 'already-active' }
      }

      const activeProfile = current.profiles.find(
        (profile) => profile.id === current.activeProfileId
      )
      if (activeProfile?.cloud) {
        // Why: profile selection changes the expected identity synchronously;
        // stale refresh saves must fail even before relaunch teardown finishes.
        recordCloudSessionIdentityMutation(
          cloudSessionIdentity(activeProfile.id, activeProfile.cloud),
          getProfileUserDataPath()
        )
      }
      // Why: the current profile must be persisted before the global index
      // points startup at the target profile.
      await flushActiveProfileBeforeFileMutation(store)
      await runBeforeProfileRelaunch(options.onBeforeRelaunch)
      setActiveKinguProfile(profileId)

      scheduleProfileRelaunch('profile-switch')

      return { status: 'relaunching' }
    }
  )

  ipcMain.handle(
    'kinguProfiles:transferProject',
    async (
      _event,
      rawArgs: TransferKinguProfileProjectArgs
    ): Promise<TransferKinguProfileProjectResult> => {
      const args = transferProjectArgsFromUnknown(rawArgs)
      const current = getKinguProfileListState()
      if (args.targetProfileId === current.activeProfileId) {
        throw new Error('active_target_kingu_profile_transfer_requires_relaunch')
      }
      if (args.mode === 'move' && args.sourceProfileId === current.activeProfileId) {
        // Why: transfer before any relaunch side effect so a duplicate-target
        // or validation failure cannot strand the app in a quitting state.
        await flushActiveProfileBeforeFileMutation(store)
        const result = transferKinguProfileProject(args, getProfileUserDataPath())
        if (result.status === 'transferred') {
          store.freezeWrites()
          await runBeforeProfileRelaunch(options.onBeforeRelaunch)
          setActiveKinguProfile(args.targetProfileId)
          scheduleProfileRelaunch('profile-transfer')
          return { ...result, willRelaunch: true }
        }
        return result
      }
      await flushActiveProfileBeforeFileMutation(store)
      return transferKinguProfileProject(args, getProfileUserDataPath())
    }
  )

  ipcMain.handle(
    'kinguProfiles:findProjectProfiles',
    (_event, rawArgs: FindKinguProfileProjectsByPathArgs): FindKinguProfileProjectsByPathResult =>
      findKinguProfileProjectsByPath(
        findProjectsByPathArgsFromUnknown(rawArgs),
        getProfileUserDataPath()
      )
  )

  ipcMain.handle(
    'kinguProfiles:connectCurrent',
    async (): Promise<ConnectCurrentKinguProfileResult> => {
      const result = await connectCurrentKinguProfile(getProfileUserDataPath())
      if (result.status === 'connected') {
        options.onAuthMutation?.()
      }
      return result
    }
  )

  ipcMain.handle(
    'kinguProfiles:createCloudLinked',
    async (
      _event,
      rawArgs?: CreateCloudLinkedKinguProfileArgs
    ): Promise<CreateCloudLinkedKinguProfileResult> => {
      const result = await createCloudLinkedKinguProfile(
        getProfileUserDataPath(),
        createCloudLinkedProfileArgsFromUnknown(rawArgs)
      )
      if (result.status === 'created') {
        seedNewKinguProfileTelemetryConsent(result.profile.id, store.getSettings().telemetry)
        options.onAuthMutation?.()
      }
      return result
    }
  )

  ipcMain.handle(
    'kinguProfiles:refreshAuth',
    async (): Promise<RefreshCurrentKinguProfileAuthResult> => {
      const result = await refreshCurrentKinguProfileAuth(getProfileUserDataPath())
      if (result.status === 'refreshed') {
        options.onAuthMutation?.()
      }
      return result
    }
  )

  ipcMain.handle(
    'kinguProfiles:signOutCurrent',
    async (): Promise<SignOutCurrentKinguProfileResult> => {
      options.onBeforeSignOut?.()
      return signOutCurrentKinguProfile(getProfileUserDataPath())
    }
  )

  ipcMain.handle(
    'kinguProfiles:selectOrg',
    async (_event, rawArgs: SelectKinguProfileOrgArgs): Promise<SelectKinguProfileOrgResult> => {
      const result = await selectCurrentKinguProfileOrg(
        getProfileUserDataPath(),
        orgIdFromUnknown(rawArgs)
      )
      if (result.status === 'selected') {
        options.onAuthMutation?.()
      }
      return result
    }
  )

  registerKinguProfileOrgMemberHandlers()
}
