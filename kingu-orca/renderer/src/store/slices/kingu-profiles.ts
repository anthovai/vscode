import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  KinguProfileAuthStatus,
  KinguProfileSummary,
  SwitchKinguProfileResult,
  TransferKinguProfileProjectArgs,
  TransferKinguProfileProjectResult
} from '../../../../shared/kingu-profiles'
import type { AppState } from '../types'
import {
  createKinguProfilesAuthActions,
  type KinguProfilesAuthActions
} from './kingu-profiles-auth-actions'

export type KinguProfilesSlice = KinguProfilesAuthActions & {
  kinguProfiles: KinguProfileSummary[]
  activeKinguProfileId: string | null
  kinguProfileAuthStatus: KinguProfileAuthStatus | null
  kinguProfilesMultiProfileUi: boolean
  kinguProfilesLoading: boolean
  kinguProfileSwitching: boolean
  fetchKinguProfiles: () => Promise<void>
  fetchKinguProfileAuthStatus: () => Promise<KinguProfileAuthStatus | null>
  createLocalKinguProfile: (name?: string) => Promise<KinguProfileSummary | null>
  switchKinguProfile: (profileId: string) => Promise<SwitchKinguProfileResult | null>
  transferKinguProfileProject: (
    args: TransferKinguProfileProjectArgs
  ) => Promise<TransferKinguProfileProjectResult | null>
}

export const createKinguProfilesSlice: StateCreator<AppState, [], [], KinguProfilesSlice> = (
  set,
  get,
  api
) => ({
  kinguProfiles: [],
  activeKinguProfileId: null,
  kinguProfileAuthStatus: null,
  kinguProfilesMultiProfileUi: false,
  kinguProfilesLoading: false,
  kinguProfileSwitching: false,

  fetchKinguProfiles: async () => {
    set({ kinguProfilesLoading: true })
    try {
      const [state, authStatus] = await Promise.all([
        window.api.kinguProfiles.list(),
        window.api.kinguProfiles.authStatus()
      ])
      set({
        activeKinguProfileId: state.activeProfileId,
        kinguProfiles: state.profiles,
        kinguProfilesMultiProfileUi: state.multiProfileUi,
        kinguProfileAuthStatus: authStatus,
        kinguProfilesLoading: false
      })
    } catch (err) {
      console.error('Failed to fetch Kingu profiles:', err)
      set({ kinguProfilesLoading: false })
    }
  },

  fetchKinguProfileAuthStatus: async () => {
    try {
      const authStatus = await window.api.kinguProfiles.authStatus()
      set({ kinguProfileAuthStatus: authStatus })
      return authStatus
    } catch (err) {
      console.error('Failed to fetch Kingu profile auth status:', err)
      return null
    }
  },

  createLocalKinguProfile: async (name) => {
    try {
      const state = await window.api.kinguProfiles.createLocal({ name })
      set({
        activeKinguProfileId: state.activeProfileId,
        kinguProfiles: state.profiles
      })
      void get().fetchKinguProfileAuthStatus()
      return state.profile
    } catch (err) {
      console.error('Failed to create Kingu profile:', err)
      toast.error(
        translate('auto.store.slices.kingu.profiles.612f7f6861', 'Failed to create profile'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  ...createKinguProfilesAuthActions(set, get, api),

  switchKinguProfile: async (profileId) => {
    if (!profileId || profileId === get().activeKinguProfileId) {
      return { status: 'already-active' }
    }
    set({ kinguProfileSwitching: true })
    try {
      const result = await window.api.kinguProfiles.switchProfile({ profileId })
      if (result?.status !== 'relaunching') {
        // Why: only a relaunch may keep the switcher locked; a stale
        // "already-active" answer would otherwise disable it forever.
        set({ kinguProfileSwitching: false })
      }
      return result
    } catch (err) {
      console.error('Failed to switch Kingu profile:', err)
      set({ kinguProfileSwitching: false })
      toast.error(
        translate('auto.store.slices.kingu.profiles.7d4bc516ee', 'Failed to switch profile'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  transferKinguProfileProject: async (args) => {
    try {
      const result = await window.api.kinguProfiles.transferProject(args)
      if (result.status === 'duplicate-target') {
        toast.error(
          translate(
            'auto.store.slices.kingu.profiles.f518e89aa5',
            'Project already exists in that profile'
          )
        )
      }
      if (result.status === 'transferred' && result.willRelaunch) {
        set({ kinguProfileSwitching: true })
      }
      return result
    } catch (err) {
      console.error('Failed to transfer Kingu profile project:', err)
      toast.error(
        translate('auto.store.slices.kingu.profiles.f03ae7f27b', 'Failed to transfer project'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  }
})
