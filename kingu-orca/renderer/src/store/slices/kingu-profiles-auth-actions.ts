import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  ConnectCurrentKinguProfileResult,
  CreateCloudLinkedKinguProfileResult,
  RefreshCurrentKinguProfileAuthResult,
  SelectKinguProfileOrgResult,
  SignOutCurrentKinguProfileResult
} from '../../../../shared/kingu-profiles'
import type { AppState } from '../types'

export type KinguProfilesAuthActions = {
  createCloudLinkedKinguProfile: (args: {
    orgId?: string
    name?: string
  }) => Promise<CreateCloudLinkedKinguProfileResult | null>
  connectCurrentKinguProfile: () => Promise<ConnectCurrentKinguProfileResult | null>
  refreshCurrentKinguProfileAuth: () => Promise<RefreshCurrentKinguProfileAuthResult | null>
  signOutCurrentKinguProfile: () => Promise<SignOutCurrentKinguProfileResult | null>
  selectKinguProfileOrg: (orgId: string) => Promise<SelectKinguProfileOrgResult | null>
}

// Why a separate module: the cloud-auth actions share the profiles slice's
// state keys but form their own cohesive surface (connect/refresh/sign-out/
// org selection), and the combined slice file exceeded the repo line budget.
export const createKinguProfilesAuthActions: StateCreator<
  AppState,
  [],
  [],
  KinguProfilesAuthActions
> = (set, get) => {
  let nextConnectAttempt = 0
  let appliedConnectAttempt = 0

  return {
    createCloudLinkedKinguProfile: async (args) => {
      try {
        const result = await window.api.kinguProfiles.createCloudLinked(args)
        set({
          kinguProfileAuthStatus: result.auth,
          ...(result.status === 'created'
            ? {
                activeKinguProfileId: result.activeProfileId,
                kinguProfiles: result.profiles
              }
            : {})
        })
        if (result.status === 'created') {
          toast.success(
            translate('auto.store.slices.kingu.profiles.319d7cf39b', 'Cloud profile created')
          )
        } else if (result.status === 'reconnect-required') {
          toast.error(
            translate('auto.store.slices.kingu.profiles.d6e764e7db', 'Reconnect this profile')
          )
        } else if (result.status === 'failed') {
          toast.error(
            translate(
              'auto.store.slices.kingu.profiles.f0c9e11a6d',
              'Failed to create cloud profile'
            ),
            { description: result.error }
          )
        }
        return result
      } catch (err) {
        console.error('Failed to create Kingu cloud profile:', err)
        toast.error(
          translate(
            'auto.store.slices.kingu.profiles.f0c9e11a6d',
            'Failed to create cloud profile'
          ),
          {
            description: err instanceof Error ? err.message : String(err)
          }
        )
        return null
      }
    },

    connectCurrentKinguProfile: async () => {
      const attempt = ++nextConnectAttempt
      try {
        // Why: a pending browser callback must not block retry. Another click
        // starts a second PKCE wait; an older wait is ignored after a newer
        // one has already linked.
        const result = await window.api.kinguProfiles.connectCurrent()
        if (attempt < appliedConnectAttempt) {
          return result
        }
        const alreadyConnected = get().kinguProfileAuthStatus?.state === 'connected'
        set({
          kinguProfileAuthStatus: result.auth,
          ...(result.status === 'connected'
            ? {
                activeKinguProfileId: result.activeProfileId,
                kinguProfiles: result.profiles
              }
            : {})
        })
        if (result.status === 'connected') {
          appliedConnectAttempt = attempt
          if (!alreadyConnected) {
            toast.success(
              translate('auto.store.slices.kingu.profiles.9fcb07a796', 'Profile connected')
            )
          }
        } else if (result.status === 'unconfigured') {
          toast.error(
            translate(
              'auto.store.slices.kingu.profiles.8b8fa73174',
              'Kingu Cloud sign-in is not configured'
            ),
            {
              description: result.auth.setupMessage
            }
          )
        } else if (
          result.status === 'failed' &&
          !alreadyConnected &&
          result.auth.state !== 'connected'
        ) {
          toast.error(
            translate('auto.store.slices.kingu.profiles.33290e88ed', 'Failed to connect profile'),
            { description: result.error }
          )
        }
        return result
      } catch (err) {
        console.error('Failed to connect Kingu profile:', err)
        if (
          attempt >= appliedConnectAttempt &&
          get().kinguProfileAuthStatus?.state !== 'connected'
        ) {
          toast.error(
            translate('auto.store.slices.kingu.profiles.33290e88ed', 'Failed to connect profile'),
            {
              description: err instanceof Error ? err.message : String(err)
            }
          )
        }
        return null
      }
    },

    refreshCurrentKinguProfileAuth: async () => {
      try {
        const result = await window.api.kinguProfiles.refreshAuth()
        set({
          kinguProfileAuthStatus: result.auth,
          ...(result.status === 'refreshed'
            ? {
                activeKinguProfileId: result.activeProfileId,
                kinguProfiles: result.profiles
              }
            : {})
        })
        if (result.status === 'reconnect-required') {
          toast.error(
            translate('auto.store.slices.kingu.profiles.d6e764e7db', 'Reconnect this profile')
          )
        } else if (result.status === 'failed') {
          toast.error(
            translate(
              'auto.store.slices.kingu.profiles.2f6c78a039',
              'Failed to refresh profile auth'
            ),
            { description: result.error }
          )
        }
        return result
      } catch (err) {
        console.error('Failed to refresh Kingu profile auth:', err)
        toast.error(
          translate(
            'auto.store.slices.kingu.profiles.2f6c78a039',
            'Failed to refresh profile auth'
          ),
          {
            description: err instanceof Error ? err.message : String(err)
          }
        )
        return null
      }
    },

    signOutCurrentKinguProfile: async () => {
      nextConnectAttempt += 1
      appliedConnectAttempt = nextConnectAttempt
      try {
        const result = await window.api.kinguProfiles.signOutCurrent()
        set({
          activeKinguProfileId: result.activeProfileId,
          kinguProfiles: result.profiles,
          kinguProfileAuthStatus: result.auth
        })
        if (result.auth.state !== 'connected') {
          toast.success(
            translate('auto.store.slices.kingu.profiles.a37b5e6d37', 'Signed out of profile')
          )
        }
        return result
      } catch (err) {
        console.error('Failed to sign out of Kingu profile:', err)
        toast.error(
          translate('auto.store.slices.kingu.profiles.83600521e7', 'Failed to sign out'),
          {
            description: err instanceof Error ? err.message : String(err)
          }
        )
        return null
      }
    },

    selectKinguProfileOrg: async (orgId) => {
      try {
        const result = await window.api.kinguProfiles.selectOrg({ orgId })
        set({
          kinguProfileAuthStatus: result.auth,
          ...(result.status === 'selected'
            ? {
                activeKinguProfileId: result.activeProfileId,
                kinguProfiles: result.profiles
              }
            : {})
        })
        if (result.status === 'reconnect-required') {
          toast.error(
            translate('auto.store.slices.kingu.profiles.d6e764e7db', 'Reconnect this profile')
          )
        } else if (result.status === 'failed') {
          toast.error(
            translate(
              'auto.store.slices.kingu.profiles.76deec8f58',
              'Failed to switch organization'
            ),
            { description: result.error }
          )
        }
        return result
      } catch (err) {
        console.error('Failed to switch Kingu profile org:', err)
        toast.error(
          translate('auto.store.slices.kingu.profiles.76deec8f58', 'Failed to switch organization'),
          {
            description: err instanceof Error ? err.message : String(err)
          }
        )
        return null
      }
    }
  }
}
