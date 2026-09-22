import {
  KINGU_APP_RESTART_ABORTED_EVENT,
  KINGU_APP_RESTART_STARTED_EVENT,
  KINGU_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
  KINGU_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../../../shared/updater-renderer-events'
import { KINGU_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT } from '../../../shared/renderer-shutdown-events'

let intentionalAppRestartInProgress = false

export function isUpdaterQuitAndInstallInProgress(): boolean {
  return isIntentionalAppRestartInProgress()
}

export function isIntentionalAppRestartInProgress(): boolean {
  return intentionalAppRestartInProgress
}

export function registerUpdaterBeforeUnloadBypass(): () => void {
  const markInProgress = (): void => {
    intentionalAppRestartInProgress = true
  }
  const clearInProgress = (): void => {
    intentionalAppRestartInProgress = false
  }

  window.addEventListener(KINGU_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT, markInProgress)
  window.addEventListener(KINGU_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT, clearInProgress)
  window.addEventListener(KINGU_APP_RESTART_STARTED_EVENT, markInProgress)
  window.addEventListener(KINGU_APP_RESTART_ABORTED_EVENT, clearInProgress)
  window.addEventListener(KINGU_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT, clearInProgress)

  return () => {
    window.removeEventListener(KINGU_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT, markInProgress)
    window.removeEventListener(KINGU_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT, clearInProgress)
    window.removeEventListener(KINGU_APP_RESTART_STARTED_EVENT, markInProgress)
    window.removeEventListener(KINGU_APP_RESTART_ABORTED_EVENT, clearInProgress)
    window.removeEventListener(KINGU_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT, clearInProgress)
    // Why: hot reloads can re-register this listener inside the same renderer.
    // Reset the module flag on cleanup so a failed earlier restart attempt
    // cannot silently suppress future unsaved-change prompts.
    intentionalAppRestartInProgress = false
  }
}
