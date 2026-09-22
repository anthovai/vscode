/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the fork's main process is allowed to reach into.
 *
 * The ADE's own `main/index.ts` cannot be the entry. It is an *application*: it
 * takes the single-instance lock, installs quit handlers, registers `open-url`
 * and `open-file`, and calls `app.whenReady()` — all at import time. The fork's
 * main process already owns every one of those, so requiring that file would
 * mean two applications fighting over one Electron.
 *
 * This is the seam `MERGE.md` said to build: reach *past* the entry point and
 * call the modules under it. Three functions, in the order `index.ts` calls
 * them, and nothing runs on import.
 *
 * The one thing the fork has to supply is a window, and the ADE already asks
 * for it as a parameter — `initializeMainProcessReady({ openMainWindow })` —
 * so the fork hands over its own `BrowserWindow` and the ADE's services come up
 * around it.
 */

export { runMainProcessPreflight } from './main/startup/main-process-preflight'
export type { MainProcessPreflightOptions } from './main/startup/main-process-preflight'

/**
 * The second window injection point, and the one that is easy to miss.
 *
 * `initializeMainProcessReady({ openMainWindow })` is not the only place the ADE
 * needs a window: `index.ts` also calls `setMainWindowOpener(openMainWindow)` at
 * module scope, so that anything reopening a window later — a deep link, a dock
 * click, a second instance — goes through the same opener. Register both with
 * the same function or the two disagree the first time something other than
 * startup asks for a window.
 */
export { setMainWindowOpener } from './main/startup/main-window-actions'

export { registerMainProcessIpcHandlers } from './main/startup/main-process-ipc-bootstrap'

export { initializeMainProcessReady } from './main/startup/main-process-ready'
export type { MainProcessRuntimeLaunchOptions } from './main/startup/main-process-runtime-launch'

/**
 * Where `window.api` actually comes from — and the least obvious thing here.
 *
 * `registerMainProcessIpcHandlers` registers about ten startup handlers. The
 * other ~690 are registered by *this*, which the ADE calls from inside its own
 * `openMainWindow` once the window exists. So a fork that supplies its own
 * window opener and stops there gets a renderer that loads, mounts, and then
 * fails every single call with "No handler registered" — which is exactly what
 * the first probe did.
 *
 * The fork's opener must create its window and then call this with it.
 */
export { attachMainWindowCoreServices } from './main/startup/main-window-core-services'

/**
 * The ADE's own singleton of everything it brought up.
 *
 * Exported because the fork needs to read it to know whether a service is ready
 * before routing a `window.api` call at one of its own services instead — the
 * substitution this merge exists to make possible, one handler at a time.
 */
export { mainProcessState } from './main/startup/main-process-state'

import { ipcMain } from 'electron'

/**
 * Hands one channel over to the host.
 *
 * This is how the host keeps the parts of itself that are already better than
 * the ADE's: the UI goes on calling the channel it always called, and the host
 * answers. No fork of the ADE's code, no change to the renderer.
 *
 * It lives here rather than in the host because the host may not use
 * `electron.ipcMain` directly — the fork's own `validatedIpcMain` refuses any
 * channel that does not start with `vscode:`, and none of the ADE's do. The
 * channels are the ADE's, so the ADE's side registers them.
 *
 * `removeHandler` first because Electron allows exactly one handler per channel
 * and throws on a second, and because this is only ever called after
 * `attachMainWindowCoreServices` has registered the ADE's own.
 */
export function overrideIpcHandler(
  channel: string,
  handler: (...args: unknown[]) => unknown
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (_event, ...args) => handler(...args))
}

/**
 * Listens for a one-way message from the ADE's renderer.
 *
 * Here for the same reason as {@link overrideIpcHandler}: the fork's own
 * `validatedIpcMain` refuses any channel that is not `vscode:`-prefixed, and
 * none of the ADE's are. The channels belong to this side, so this side listens.
 */
export function onHostMessage(
  channel: string,
  handler: (payload: unknown) => void
): void {
  ipcMain.on(channel, (_event, payload) => handler(payload))
}

/**
 * The ADE's task providers, as plain functions.
 *
 * The first capability moved across under the settled direction: the Agents
 * Window is the program, and the ADE's engine answers behind it. The window has
 * no Tasks page at all, and the ADE has four working providers, so this is the
 * shortest path from "two programs" to "one program that can do more".
 *
 * Exported as functions rather than reached over IPC because both sides are the
 * same process. `main/ipc/linear.ts` wraps exactly these in `ipcMain.handle` for
 * the ADE's own renderer; the fork calls them directly and pays for no round
 * trip, no serialisation and no channel name.
 *
 * Only the two providers with a uniform `getStatus` are here. GitHub and GitLab
 * report authentication through `auth-diagnose` and `gitlab-auth-and-rate-limit`
 * instead, which is a different shape and a separate piece of work — better a
 * gap that is visible than a fourth entry that quietly reports nothing.
 */
export { getStatus as getLinearStatus } from './main/linear/client'
export { getStatus as getJiraStatus } from './main/jira/client'
