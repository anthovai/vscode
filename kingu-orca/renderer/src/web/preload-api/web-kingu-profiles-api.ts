import type { PreloadApi } from '../../../../preload/api-types'
import {
  DEFAULT_LOCAL_KINGU_PROFILE_ID,
  createDefaultLocalKinguProfile
} from '../../../../shared/kingu-profiles'
import { noopUnsubscribe } from './web-storage'

export function createWebKinguProfilesApi(): Partial<PreloadApi> {
  const webKinguProfileAuthStatus = () =>
    Promise.resolve({
      activeProfileId: DEFAULT_LOCAL_KINGU_PROFILE_ID,
      configured: false,
      state: 'unconfigured' as const,
      persistence: 'none' as const,
      setupMessage: 'Kingu Cloud sign-in is not available in the browser fallback.'
    })
  return {
    kinguProfiles: {
      list: () =>
        Promise.resolve({
          activeProfileId: DEFAULT_LOCAL_KINGU_PROFILE_ID,
          profiles: [createDefaultLocalKinguProfile(0)],
          multiProfileUi: false
        }),
      authStatus: webKinguProfileAuthStatus,
      onAuthStatusChanged: () => noopUnsubscribe,
      createLocal: () =>
        Promise.resolve({
          activeProfileId: DEFAULT_LOCAL_KINGU_PROFILE_ID,
          profiles: [createDefaultLocalKinguProfile(0)],
          profile: createDefaultLocalKinguProfile(0)
        }),
      createCloudLinked: async () => ({
        status: 'unconfigured',
        auth: await webKinguProfileAuthStatus()
      }),
      switchProfile: () => Promise.resolve({ status: 'already-active' }),
      transferProject: (args) =>
        Promise.resolve({
          status: 'duplicate-target',
          sourceProfileId: args.sourceProfileId,
          targetProfileId: args.targetProfileId,
          sourceRepoId: args.repoId,
          duplicateRepoId: args.repoId
        }),
      findProjectProfiles: async () => ({ projects: [] }),
      connectCurrent: async () => ({
        status: 'unconfigured',
        auth: await webKinguProfileAuthStatus()
      }),
      refreshAuth: async () => ({
        status: 'unconfigured',
        auth: await webKinguProfileAuthStatus()
      }),
      signOutCurrent: async () => ({
        status: 'signed-out',
        auth: await webKinguProfileAuthStatus(),
        activeProfileId: DEFAULT_LOCAL_KINGU_PROFILE_ID,
        profiles: [createDefaultLocalKinguProfile(0)]
      }),
      selectOrg: async () => ({
        status: 'unconfigured',
        auth: await webKinguProfileAuthStatus()
      }),
      orgMembersList: async () => ({ status: 'unconfigured' }),
      orgMemberInvite: async () => ({ status: 'unconfigured' }),
      orgInviteRevoke: async () => ({ status: 'unconfigured' }),
      orgMemberChangeRole: async () => ({ status: 'unconfigured' }),
      orgMemberRemove: async () => ({ status: 'unconfigured' })
    }
  }
}
