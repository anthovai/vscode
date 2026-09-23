/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Keeps a second reference to every handler Kingu registers with `ipcMain`.
 *
 * Kingu's backend is exposed entirely as `ipcMain.handle(channel, handler)` —
 * about seven hundred of them, one per call its renderer makes. When a host
 * window wants Kingu's behaviour without Kingu's renderer, those handlers are
 * the API: the same code, answering the same requests, with every side effect
 * the renderer's call would have had. Electron offers no way to invoke a
 * registered handler from the main process, so this keeps the map itself.
 *
 * Imported first by `fork-entry.ts`, before anything that registers a handler.
 * Channels prefixed `vscode:` are the host's own and are not recorded.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()

const originalHandle = ipcMain.handle.bind(ipcMain)
const originalRemoveHandler = ipcMain.removeHandler.bind(ipcMain)

ipcMain.handle = (channel: string, listener: Handler): void => {
  if (!channel.startsWith('vscode:')) {
    handlers.set(channel, listener)
  }
  originalHandle(channel, listener)
}

ipcMain.removeHandler = (channel: string): void => {
  handlers.delete(channel)
  originalRemoveHandler(channel)
}

/** Whether Kingu answers this channel. */
export function hasKinguHandler(channel: string): boolean {
  return handlers.has(channel)
}

/**
 * Calls Kingu's handler for `channel` as if its renderer had.
 *
 * `event` stands in for the renderer's: handlers read `event.sender` to know
 * which window asked, so the host passes the web contents Kingu treats as its
 * main window.
 */
export async function invokeKinguHandler(
  channel: string,
  event: IpcMainInvokeEvent,
  args: readonly unknown[]
): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`No Kingu handler for ${channel}`)
  }
  return await handler(event, ...args)
}
