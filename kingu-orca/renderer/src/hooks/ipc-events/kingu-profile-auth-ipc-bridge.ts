import { useAppStore } from '../../store'

/** Re-reads auth status when main clears a revoked cloud session behind the renderer's back. */
export function registerKinguProfileAuthIpcBridge(unsubs: (() => void)[]): void {
  const subscribe = window.api.kinguProfiles?.onAuthStatusChanged
  if (typeof subscribe !== 'function') {
    return
  }
  unsubs.push(
    subscribe(() => {
      void useAppStore.getState().fetchKinguProfileAuthStatus()
    })
  )
}
