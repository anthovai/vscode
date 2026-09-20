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

## How it builds

`npm run build-kingu-orca` → `out-kingu-orca/main.cjs`, 27.9 MB from 6,209
inputs in about three seconds.

`src/tsconfig.json` includes only `./vs/**`, so nothing here is type-checked,
layering-linted or touched by the fork's own build. That is the point: vendored
code held to the fork's rules is code you have to edit.

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

## What is not done

Nothing calls this yet. `main/index.ts` owns an application lifecycle: it
creates its own `BrowserWindow`, its own daemon, its own tray. The fork's main
process already owns those, so the seam cannot be "run their `index.ts`".

The next step is to reach past the entry point and call the modules under it —
`main/ipc`, `main/runtime`, `main/ai-vault` — from a fork service, then put the
fork's own UI in front of them. That is where the adapting actually happens,
and it is the work this commit makes possible rather than the work it does.
