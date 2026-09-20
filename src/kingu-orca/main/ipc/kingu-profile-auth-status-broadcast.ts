import { BrowserWindow } from 'electron'
import { KINGU_PROFILE_AUTH_STATUS_CHANGED_CHANNEL } from '../../shared/kingu-profiles'

export function broadcastKinguProfileAuthStatusChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(KINGU_PROFILE_AUTH_STATUS_CHANGED_CHANNEL)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}
