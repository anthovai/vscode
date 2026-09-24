# The ADE, vendored

This directory is the Agentic Development Environment's own source, copied in
whole and left alone. It is not fork code and it is not written to the fork's
rules.

## Why it is here rather than ported

The port in `src/vs/sessions/contrib/kingu` rebuilt features one at a time,
reading the ADE's source and reaching the same end through the fork's own
seams. That produced better code — a desktop tool group every provider gets at
once, remote scanning that falls out of `IFileService` — but it is slow, and it
is only worth doing where the fork's stack actually buys something.

Most of the ADE is not that. It is 11,795 TypeScript files of backend logic —
SSH, worktrees, automations, the session vault, provider bridges — that owe
nothing to React and nothing to electron-vite. Rewriting those into the fork's
layers would take a year and would be stale the moment upstream moves.

So: bring the source in as it is, bundle it, and call it across one seam. Build
the UI against it afterwards, in the fork's window, at whatever pace suits.

## What was copied

| Path | From | What |
| --- | --- | --- |
| `main/` | `src/main` | The Electron main process: every backend capability |
| `shared/` | `src/shared` | Types and helpers both processes use |
| `preload/` | `src/preload` | The renderer bridge |
| `relay/` | `src/relay` | The remote relay |
| `types/` | `src/types` | Ambient declarations |
| `resources/` | `resources` | Icons, tray images, notification sounds |
| `renderer/src/i18n/locales/` | same | Translations the main process reads |

The React renderer was not copied. Its UI is the part being replaced.

**That changed.** The direction is now the opposite: the ADE's UI *is* the Agents
Window, and the fork's own Agents UI comes out. So `renderer/` is here in full —
10,128 files — and builds through `vite.renderer.config.ts` into
`out-kingu-orca/renderer`. See *The renderer* below.

## How it builds

`npm run build-kingu-orca` → `out-kingu-orca/main.cjs`, 27.9 MB from 6,209
inputs in about three seconds.

Nothing here is type-checked, layering-linted or touched by the fork's own
build. That is the point: vendored code held to the fork's rules is code you
have to edit.

**It has to live beside `src/`, not inside it.** The first attempt put it at
`src/kingu-orca` on the reasoning that `src/tsconfig.json` includes only
`./vs/**`. That much was true, and it was not enough: the gulp build streams
`gulp.src('src/**')` — every file under `src/`, tsconfig or no tsconfig — and
hands each to the transpiler, which asks tsc for an output name for a file that
is not in its program and fails the whole build with `Expected fileName to be
present in command line`. Type-checking was never the only thing that walks a
directory.

Three things the build has to handle, and nothing else:

- **Asset imports.** electron-vite's `import icon from './x.png?asset'` means
  "give me a path, not the bytes". A plugin copies the file next to the bundle
  and rewrites the import to that path. The ADE reaches `resources/` from its
  repository root, so vendored one directory deeper those paths escape into the
  fork's `src/`; the plugin catches that and re-roots them.
- **Externals.** `electron`, `node-pty`, `@parcel/watcher`, `ssh2`,
  `sherpa-onnx`, `*.node` — native or already the fork's. Plus `jsonc-parser`,
  whose UMD wrapper does a `require()` esbuild cannot follow.
- **Dependencies.** Ten packages the fork lacked, and a zod bump from 4.4.3 to
  4.5.4 for `compile`. The fork already had the heavy ones — `ssh2`,
  `node-pty`, `ws`, `@parcel/watcher`, `@xterm/headless`, the Claude Agent SDK.

## What this proved

Of 11,795 files, **zero failed for a source-level reason**. Every error in the
first build was a missing npm package or an unhandled asset suffix. The ADE's
backend and the fork's Node layer are the same language against the same
runtime, and nothing in the fork rejects it.

The bundle loads and begins executing the ADE's real startup under a stubbed
`electron`. It stops where that stub runs out — `app.getPath()` returning a
proxy — which is as far as a stub can go.

## The renderer

`renderer/` is the ADE's UI in full: 10,128 files, 2,458 of them `.tsx`. It
builds through `vite.renderer.config.ts` into `out-kingu-orca/renderer`
(`index.html`, `popout.html`, 45 MB).

**Its dependencies are its own.** `kingu-orca/package.json` and
`kingu-orca/node_modules` hold the 82 packages the renderer imports, installed
apart from the fork's. Not for tidiness: the two repositories disagree on 24
package versions, every one of them native or runtime — `node-pty`,
`@xterm/headless`, `@anthropic-ai/claude-agent-sdk`. None of them can reach the
renderer, because `renderer-node-builtin-boundary.test.ts` walks the import
graph from every entry and refuses any `node:` builtin: the renderer runs
sandboxed under `contextIsolation`, where a builtin does not resolve and even
reading `process` throws. A browser-only tree cannot conflict with a native one,
so the conflicts simply do not arise.

The asset rule from the main bundle applies here too, in
`reRootEscapingAssets`, for the same reason and by the same positional test.
Two builders, one rule.

## The seam

`fork-entry.ts` is what the fork's main process requires, and
`build.mjs` bundles *it* rather than `main/index.ts`.

That is the whole of the problem this document used to end on. `main/index.ts`
is an application: it takes the single-instance lock, installs quit handlers,
registers `open-url` and `open-file`, and calls `app.whenReady()` — at import
time. Requiring it would start a second application inside the fork's. So the
entry exports three functions and runs nothing:

```
runMainProcessPreflight()
registerMainProcessIpcHandlers()
initializeMainProcessReady({ openMainWindow, handleMacAppActivation })
```

The order is `index.ts`'s own. The adaptation surface is those three plus the
four startup modules under them — about a thousand lines, not the 9,117 files in
`main/`. And the one thing the fork must own, the window, the ADE already asks
for as a parameter: `openMainWindow(options): BrowserWindow`. The fork passes
its own.

`startup.cjs` bundles to 24.6 MB from 5,829 inputs — 380 fewer than the old
`main.cjs`, which is exactly the application lifecycle left behind.

## The sidecars

The ADE is not one process. Its main process starts eighteen other files *by
path*: the terminal daemon it `fork()`s (every PTY lives there), the plugin
host, seven worker threads, two webview preloads, and the modules its CLI
imports. Each resolver asks for `<app.getAppPath()>/out/main/<name>.js`, and
several read `electron.app` directly rather than through the `AppEnvironment`
port — so no seam on our side can reroute them one by one.

The answer is one move in each direction:

- `build-kingu-orca` bundles all eighteen entries to `kingu-orca/out/main/`,
  under the names the ADE's own `electron.vite.config.ts` gives them, verbatim.
- In an `--orca` boot the host points `app.getAppPath()` at `kingu-orca/`,
  which the fork's own code never reads. The vendored tree really is the ADE's
  repository root — `resources/` is in it, `node_modules/` is in it, and now
  `out/main/` is too — so every resolver, and the resource lookups beside them,
  find the ADE's dev layout unchanged.

Two things the first run taught:

- `kingu-orca/package.json` says `"type": "module"` for the renderer's sake,
  which made Node read the CommonJS `daemon-entry.js` as an ES module and kill
  the daemon on its first `module.exports`. The entry names cannot change — the
  resolvers ask for `<name>.js` verbatim — so `kingu-orca/out/package.json`
  declares `"type": "commonjs"` and scopes them out.
- The natives resolve upward, by design: `node-pty`, `ssh2` and
  `@parcel/watcher` are external in the sidecar bundles and land on the fork's
  copies in the repository root's `node_modules` — built for Electron's ABI,
  which is what a child forked from the fork's own binary under
  `ELECTRON_RUN_AS_NODE` runs.

Proven by running it: the daemon comes up (`daemon-entry.js --socket
\\?\pipe\kingu-terminal-host-v36-…` under the fork's binary), a workspace's
Terminal 1 opens on a real PowerShell prompt in the worktree, and what is typed
comes back through the daemon.

## One title bar

The window has one title bar and it is the Agents Window's, because a window
that used both had two skins and no single switch to change them together.

Its layout is not reimplemented. The fork's two stylesheets are vendored under
`renderer/src/app-shell/agents-titlebar/`, copied byte for byte and never
edited:

| Vendored | From |
| --- | --- |
| `titlebarpart.css` | `src/vs/sessions/browser/parts/media/` |
| `sessionsTitleBarWidget.css` | `src/vs/sessions/contrib/sessions/browser/media/` |
| `codicons/codicon.ttf` | `src/vs/base/browser/ui/codicons/codicon/` |

The icons are the fork's too — the same font, and the same codicon per control as
the menu item that registers it: `layout-sidebar-left`, `arrow-left`,
`arrow-right`, `play`, `vscode-insiders`, `layout-panel`, `layout-sidebar-right`,
`radio-tower`, each swapping to its `-off` variant on toggle exactly where the
fork registers two mutually exclusive items instead of one toggled one.

The font ships without a single `.codicon-x:before` rule: the workbench builds
those at runtime from `getCodiconFontCharacters()` through `iconsStyleSheet.ts`,
and this renderer has no theme service. `build/kingu-orca/generate-codicon-css.mjs`
writes them ahead of time from the same `codiconsLibrary.ts` — generated, not
hand-copied, because a wrong codepoint still renders a glyph and would never
look like a bug.

`codicon.css` is the one file deliberately *not* vendored. It declares
`font-family: "codicon"`, and this renderer already carries Monaco's copy of
that font under that exact name; two `@font-face` rules for one family is a coin
toss over which glyph set wins. `bridge.css` declares the same file under
`kingu-agents-codicon` instead, and every generated rule is scoped to
`.agent-sessions-workbench`, so Monaco keeps `codicon` to itself.

`TitlebarCommandCenter.tsx` exists to emit the DOM those files are written
against — the tree `titlebarPart.ts` builds and the pill
`sessionsTitleBarWidget.ts` renders, under the `.agent-sessions-workbench
.monaco-workbench .part.titlebar` ancestors their selectors are scoped to.

Copying rather than retyping is the point, and it took three attempts to learn
it. The first two reasoned from screenshots and were never centred, because the
centring is two rules working together — `flex: 1 1 0` on the side sections and a
`1fr auto 1fr` grid inside the centre — and either alone looks nearly right. A
vendored file cannot be half-remembered, and an upstream change is a re-copy
instead of a re-reading.

`bridge.css` is the only new stylesheet, and it holds just two things:

- the 19 `--vscode-*` variables those files read, mapped to Kingu's tokens —
  which is what makes one theme switch move this with everything else;
- what the *workbench* draws around them and the sessions files therefore
  assume: the bar's height and background, `display: flex` on `.titlebar-left`
  and `.titlebar-right` (without which the right group stacks vertically),
  `z-index: -1` on the drag region (without which it covers every control), and
  plain buttons, because the fork's are monaco action-bar items.

`sessionsTitleBarWidget.ts` itself could not come across: it is a
`BaseActionViewItem` on the workbench's dependency injection, menu registry and
observables, rendering an `ISessionsService` Kingu does not have. So the DOM and
the styling are the fork's; the wiring is Kingu's store:

| Agents Window | Here |
| --- | --- |
| Show Sessions (the pill) | the worktree jump palette |
| Run Script | `QuickLaunchAgentMenuItems`, the list the tab bar's `+` opens |
| Open in VS Code | `host.openIde()` |
| Toggle Panel | the floating terminal |
| Toggle Side Pane | the right sidebar |
| Allow Remote Connections | Kingu Mobile pairing settings — Kingu has no one-click tunnel toggle |
| Account widget | the active Kingu profile, drawn from initials; profiles carry no photo |

The bar is the window's own top row, above the workspace shell, so it spans the
sidebar, the panes and the right sidebar the way the fork's does. Kingu's tab
strip and Command button keep their row and move down one, which is how the
fork's window is arranged too: chrome on top, tabs beneath. Kingu's own left
chrome — logo, application-menu button, sidebar toggle — is gone from that lower
row, because leaving it drew a second chrome strip with a second sidebar toggle
directly under the first, and the window read as two unrelated halves. The
application menu is still reachable with Alt, which is all the fork's Agents
Window offers either.

Two details decide whether the bar looks part of the window or bolted onto it,
and both are the fork's, not a simplification: `titlebarPart.ts` paints the bar
with `agents.background`, which in dark themes *is* `editorBackground`, and
`titlebarpart.css` sets `box-shadow: none` on it. So the bar carries the
window's own background and no rule underneath.

The pill's blocked ("N sessions require input") and approved states are styled
by the vendored CSS but nothing feeds them yet; they need a Kingu signal for
"this agent is waiting on me".

## What is not done

`window.api` is 699 IPC channels across 138 preload modules, and the
substitution this merge exists for has barely started: each one can be
re-pointed from the ADE's service to the fork's — its git, its agent host
protocol — one handler at a time, without the UI knowing.
`fork-entry.ts`'s `overrideIpcHandler` is how; two channels use it so far.

Still open: the updater logs 404s against an endpoint that is not ours, and the
cloud-backed surfaces (artifacts, skill share/install) still point at the ADE's
production host rather than the `cloud/` workspace in this repo, so they stay
switched off until that is stood up here.

## Updating from the ADE

The copy here is `anthovai/kingu-intelligence` at **`6827fbe3c`** (upstream
`stablyai/orca` `122b8c25d`, 2026-09-24). To move it forward:

1. In `kingu-intelligence`, sync upstream: `git merge -s ours --no-commit <upstream>`,
   then `node config/scripts/kingu-sync-upstream.mjs <last-upstream> <upstream>`,
   resolve what it lists, commit.
2. Here: `node build/kingu-orca/revendor.ts ../kingu-intelligence <vendored-commit> <new-commit>`.
   It keeps the fork's edits to vendored files (`preload/index.ts`'s host bridge,
   the title-bar entry in `shared/telemetry-property-schemas.ts`) and reports any
   file both sides changed. Then update the commit above.
3. Add any dependency the ADE's renderer gained to `kingu-orca/package.json`, run the
   `generate-*.mjs` scripts, then `build/kingu-brand/rename-*.ts`, and `npm run build-kingu-orca`.
