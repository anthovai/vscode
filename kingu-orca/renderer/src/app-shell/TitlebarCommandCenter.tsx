// The fork's own stylesheets and icon font, copied byte for byte and never
// edited, plus the one file that tells them what Kingu's colours are. The
// codicon rules are generated from the fork's library — see
// build/kingu-orca/generate-codicon-css.mjs and bridge.css.
import './agents-titlebar/titlebarpart.css'
import './agents-titlebar/sessionsTitleBarWidget.css'
import './agents-titlebar/codicons/codicons.generated.css'
import './agents-titlebar/bridge.css'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { QuickLaunchAgentMenuItems } from '@/components/tab-bar/QuickLaunchButton'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import {
  canGoBackWorktreeHistory,
  canGoForwardWorktreeHistory
} from '@/store/slices/worktree-nav-history'
import { shouldShowWorktreeHistoryControls } from '../lib/titlebar-worktree-history-controls'
import { isHostedWindow } from '@/lib/desktop-window-chrome'
import { useShortcutLabel } from '../hooks/useShortcutLabel'
import { useAppStore } from '../store'
import { hasCustomTitleBar } from './app-window-chrome'
import type { FloatingWorkspacePanelState } from './use-floating-workspace-panel'

/** A codicon, rendered the way the fork's action bar renders one. */
function Icon({ name }: { name: string }): React.JSX.Element {
  return <div className={`codicon codicon-${name}`} aria-hidden />
}

/**
 * The Agents Window title bar.
 *
 * Its layout is not reimplemented here. The fork's own stylesheets are vendored
 * beside this file unedited, and this component's whole job is to emit the DOM
 * they are written against — the tree `titlebarPart.ts` builds and the pill
 * `sessionsTitleBarWidget.ts` renders, with their class names:
 *
 *   .part.titlebar > .titlebar-container.sessions-titlebar-container.has-center
 *     .titlebar-left    > .left-toolbar-container
 *     .titlebar-center  > .titlebar-center-nav-container
 *                       > .window-title > .command-center
 *                         > .agent-sessions-titlebar-container
 *                           > .agent-sessions-titlebar-pill
 *                       > .titlebar-center-actions-container
 *     .titlebar-right   > .titlebar-session-actions-container
 *                       > .titlebar-right-layout-container
 *                       > .window-controls-container
 *
 * Copying the CSS rather than retyping it is the point. Two earlier attempts
 * reasoned from screenshots and were never centred, because the centring is two
 * rules working together — `flex: 1 1 0` on the side sections, and a
 * `1fr auto 1fr` grid inside the centre — and either one alone looks nearly
 * right. Vendoring the file means those rules cannot be half-remembered, and it
 * means an upstream change is a re-copy rather than a re-reading.
 *
 * `.has-no-actions` is load-bearing: the fork's CSS hides an actions container
 * that carries it, which is how the flanking toolbars disappear when empty
 * instead of leaving a gap.
 *
 * What is *not* the fork's is where each control points.
 * `sessionsTitleBarWidget.ts` itself could not come across — it is a
 * `BaseActionViewItem` built on the workbench's dependency injection, menu
 * registry and observables, and it renders an `ISessionsService` that does not
 * exist in Kingu. So the DOM and the styling are the fork's, and the wiring is
 * Kingu's own store.
 */
export function TitlebarCommandCenter({
  floatingWorkspace
}: {
  floatingWorkspace: FloatingWorkspacePanelState
}): React.JSX.Element {
  const activeView = useAppStore((state) => state.activeView)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const repos = useAppStore((state) => state.repos)
  const activeGroupId = useAppStore((state) =>
    activeWorktreeId ? state.activeGroupIdByWorktree[activeWorktreeId] : undefined
  )
  const kinguProfiles = useAppStore((state) => state.kinguProfiles)
  const authStatus = useAppStore((state) => state.kinguProfileAuthStatus)
  const openModal = useAppStore((state) => state.openModal)
  const toggleSidebar = useAppStore((state) => state.toggleSidebar)
  const toggleRightSidebar = useAppStore((state) => state.toggleRightSidebar)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const rightSidebarOpen = useAppStore((state) => state.rightSidebarOpen)
  const canGoBackWorktree = useAppStore(canGoBackWorktreeHistory)
  const canGoForwardWorktree = useAppStore(canGoForwardWorktreeHistory)
  const leftSidebarShortcutLabel = useShortcutLabel('sidebar.left.toggle')
  const rightSidebarShortcutLabel = useShortcutLabel('sidebar.right.toggle')
  const historyBackShortcutLabel = useShortcutLabel('worktree.history.back')
  const historyForwardShortcutLabel = useShortcutLabel('worktree.history.forward')

  // A worktree id is `${repoId}::${path}`, but the id's format is the store's
  // business, not this file's — the bucket it lives in already carries the repo.
  const worktree = activeWorktreeId
    ? Object.values(worktreesByRepo ?? {})
        .flat()
        .find((candidate) => candidate.id === activeWorktreeId)
    : undefined
  const repo = worktree?.repoId
    ? repos?.find((candidate) => candidate.id === worktree.repoId)
    : undefined

  // The widget's `_getCommandCenterTitles`: the pill reads "session · context",
  // and collapses to one label when the two would say the same thing.
  const sessionTitle = worktree?.displayName
  const rawContextTitle = repo?.displayName
  const contextTitle = rawContextTitle ?? sessionTitle
  const leadTitle = !sessionTitle || sessionTitle === rawContextTitle ? undefined : sessionTitle

  const hosted = isHostedWindow()
  const showHistory = shouldShowWorktreeHistoryControls(activeView)
  // The launch menu needs a worktree and a group to put the tab in; without
  // either there is nothing for it to act on, so it is left out rather than
  // shown disabled.
  const canLaunch = Boolean(activeWorktreeId && activeGroupId)
  const hasCenterActions = canLaunch || hosted

  const activeProfile = kinguProfiles?.find(
    (candidate) => candidate.id === authStatus?.activeProfileId
  )
  const profileInitials = activeProfile?.avatar.initials ?? '?'
  const profileName = activeProfile?.name

  // The fork registers Show Panel and Hide Panel as two mutually exclusive menu
  // items rather than one toggled item, so the label changes with the state.
  const toggleTerminalLabel = floatingWorkspace.open
    ? translate('auto.App.kingu.hidePanel', 'Hide Panel')
    : translate('auto.App.kingu.showPanel', 'Show Panel')

  const openSettingsAt = (pane: string): void => {
    openSettingsTarget({ pane, repoId: null })
    openSettingsPage()
  }

  return (
    // The fork's CSS is scoped under these two ancestors; without them not a
    // single rule in the vendored files matches.
    <div className="agent-sessions-workbench monaco-workbench">
      <div className="part titlebar">
        <div className="titlebar-container sessions-titlebar-container has-center">
          <div className="titlebar-drag-region" />

          <div className="titlebar-left">
            <div className="left-toolbar-container">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="agents-titlebar-button"
                    onClick={toggleSidebar}
                    aria-label={translate('auto.App.e4b9e7dff7', 'Toggle sidebar')}
                  >
                    <Icon name={sidebarOpen ? 'layout-sidebar-left' : 'layout-sidebar-left-off'} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate('auto.App.ce37cf5279', 'Toggle sidebar ({{value0}})', {
                    value0: leftSidebarShortcutLabel
                  })}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          <div className="titlebar-center">
            <div
              className={`titlebar-actions-container titlebar-center-nav-container${
                showHistory ? '' : ' has-no-actions'
              }`}
            >
              {showHistory && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className="agents-titlebar-button"
                        onClick={() => useAppStore.getState().goBackWorktree()}
                        disabled={!canGoBackWorktree}
                        aria-label={translate('auto.App.064bd07810', 'Go back')}
                      >
                        <Icon name="arrow-left" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      {translate('auto.App.fe21e8f6f5', 'Go back ({{value0}})', {
                        value0: historyBackShortcutLabel
                      })}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className="agents-titlebar-button"
                        onClick={() => useAppStore.getState().goForwardWorktree()}
                        disabled={!canGoForwardWorktree}
                        aria-label={translate('auto.App.cf9099fe98', 'Go forward')}
                      >
                        <Icon name="arrow-right" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      {translate('auto.App.f7aa73e785', 'Go forward ({{value0}})', {
                        value0: historyForwardShortcutLabel
                      })}
                    </TooltipContent>
                  </Tooltip>
                </>
              )}
            </div>

            <div className="window-title">
              <div className="command-center">
                {contextTitle ? (
                  <div
                    className="agent-sessions-titlebar-container"
                    role="button"
                    tabIndex={0}
                    aria-label={translate(
                      'auto.App.kingu.showWorkspaces',
                      'Show workspaces: {{value0}}',
                      { value0: contextTitle }
                    )}
                    // The widget's pill opens the sessions picker; Kingu's
                    // equivalent is the worktree jump palette — the same
                    // question asked of the same list.
                    onClick={() => openModal('worktree-palette')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openModal('worktree-palette')
                      }
                    }}
                  >
                    <div className="agent-sessions-titlebar-pill">
                      <div className="agent-sessions-titlebar-center">
                        {leadTitle && (
                          <div className="agent-sessions-titlebar-session">{leadTitle}</div>
                        )}
                        {leadTitle && (
                          <span className="agent-sessions-titlebar-separator" aria-hidden>
                            ·
                          </span>
                        )}
                        <div className="agent-sessions-titlebar-workspace-group">
                          <div
                            className="agent-sessions-titlebar-workspace-icon codicon codicon-folder"
                            aria-hidden
                          />
                          <div className="agent-sessions-titlebar-workspace">{contextTitle}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div
              className={`titlebar-actions-container titlebar-center-actions-container${
                hasCenterActions ? '' : ' has-no-actions'
              }`}
            >
              {canLaunch && activeWorktreeId && activeGroupId && (
                // Why one menu behind both halves: the fork's run control is a
                // split button, but Kingu has no single "run the default agent"
                // entry point — `QuickLaunchAgentMenuItems` already orders the
                // configured default first, so the menu is one click either way
                // and no launch logic is duplicated to fake a primary action.
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="agents-titlebar-button"
                      aria-label={translate('auto.App.kingu.run', 'Run')}
                    >
                      <Icon name="play" />
                      <Icon name="chevron-down" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="center" className="min-w-56">
                    <QuickLaunchAgentMenuItems
                      worktreeId={activeWorktreeId}
                      groupId={activeGroupId}
                      onFocusTerminal={focusTerminalTabSurface}
                      launchSource="titlebar_quick_launch"
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {hosted && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className="agents-titlebar-button"
                      onClick={() => void window.api.host?.openIde()}
                      aria-label={translate('auto.App.kingu.openInEditor', 'Open in Editor')}
                    >
                      <Icon name="vscode-insiders" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {translate('auto.App.kingu.openInEditor', 'Open in Editor')}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>

          {/* The fork's right group, slot for slot. Its commands do not exist
              here, so each is wired to the nearest thing Kingu already has:
              Toggle Panel → the floating terminal, Toggle Side Pane → the right
              sidebar, Allow Remote Connections → the Kingu Mobile pairing
              settings (Kingu has no one-click tunnel toggle), and the account
              widget → the active profile. */}
          <div className="titlebar-right">
            <div className="titlebar-actions-container titlebar-session-actions-container">
              {floatingWorkspace.enabled && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className={`agents-titlebar-button${floatingWorkspace.open ? ' checked' : ''}`}
                      onClick={() => floatingWorkspace.setOpenWithFocus(!floatingWorkspace.open)}
                      aria-label={toggleTerminalLabel}
                    >
                      <Icon name={floatingWorkspace.open ? 'layout-panel' : 'layout-panel-off'} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {toggleTerminalLabel}
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="agents-titlebar-button"
                    onClick={toggleRightSidebar}
                    aria-label={translate('auto.App.9e0b441a91', 'Toggle right sidebar')}
                  >
                    <Icon name={rightSidebarOpen ? 'layout-sidebar-right' : 'layout-sidebar-right-off'} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate('auto.App.c184e056de', 'Toggle right sidebar ({{value0}})', {
                    value0: rightSidebarShortcutLabel
                  })}
                </TooltipContent>
              </Tooltip>
            </div>

            <div className="titlebar-actions-container titlebar-right-layout-container">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="agents-titlebar-button"
                    onClick={() => openSettingsAt('mobile')}
                    aria-label={translate(
                      'auto.App.kingu.remoteConnections',
                      'Allow remote connections'
                    )}
                  >
                    <Icon name="radio-tower" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate('auto.App.kingu.remoteConnections', 'Allow Remote Connections')}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="agents-titlebar-avatar"
                    onClick={() => openSettingsAt('kingu-account')}
                    aria-label={
                      profileName
                        ? translate('auto.App.kingu.accountNamed', 'Account: {{value0}}', {
                            value0: profileName
                          })
                        : translate('auto.App.kingu.account', 'Account')
                    }
                  >
                    {profileInitials}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {profileName ?? translate('auto.App.kingu.account', 'Account')}
                </TooltipContent>
              </Tooltip>
            </div>

            {hasCustomTitleBar && <div className="window-controls-container" />}
          </div>
        </div>
      </div>
    </div>
  )
}
