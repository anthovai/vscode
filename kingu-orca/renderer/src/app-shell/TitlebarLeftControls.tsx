import { isMac } from './app-window-chrome'
import type { AppChromeLayout } from './use-app-chrome-layout'

/**
 * What is left of the titlebar's left cluster: the macOS traffic-light gutter.
 *
 * The logo, the application-menu button and the sidebar toggle all moved to
 * {@link TitlebarCommandCenter}, which is the Agents Window's own title bar and now the
 * window's only one. Leaving them here drew a second chrome row under the first — two
 * sidebar toggles, one above the other — which is what made the window read as two
 * unrelated halves rather than one program.
 *
 * On Windows and Linux the application menu is still reachable with Alt, which is how the
 * fork's own Agents Window exposes it: that window has nothing on the left but the sidebar
 * toggle either.
 */
export function TitlebarLeftControls({ layout }: { layout: AppChromeLayout }): React.JSX.Element {
  return (
    // Why: measure the ENTIRE row so TabGroupPanel's collapse spacer reserves enough width.
    <div
      ref={layout.titlebarLeftControlsRef}
      className={`flex h-full shrink-0 items-center${
        layout.leftTitlebarChromeLayout.isFloating ? ' w-max' : ' w-full'
      }`}
    >
      {isMac && !layout.isFullScreen ? <div className="titlebar-traffic-light-pad" /> : null}
    </div>
  )
}
