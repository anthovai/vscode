export type DesktopWindowChromeInput = {
  platform: NodeJS.Platform
  isWebClient: boolean
}

export function isPairedWebClientWindow(): boolean {
  return (globalThis as { __KINGU_WEB_CLIENT__?: boolean }).__KINGU_WEB_CLIENT__ === true
}

export function isLocalWindowsDesktopClient(): boolean {
  return (
    !isPairedWebClientWindow() &&
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Windows')
  )
}

export function shouldRenderDesktopWindowChrome({
  platform,
  isWebClient
}: DesktopWindowChromeInput): boolean {
  return !isWebClient && (platform === 'win32' || platform === 'linux')
}

/**
 * Whether a host window is drawing the chrome for us.
 *
 * Read from the preload's launch arguments rather than asked over IPC, so it is
 * known before first paint — an answer that arrives a frame later would show
 * the window buttons and then take them away again.
 */
export function isHostedWindow(): boolean {
  return (globalThis as { __KINGU_HOSTED__?: boolean }).__KINGU_HOSTED__ === true
}
