# The Kingu runtime, and why the UI arrives whole

This is the seam that puts Kingu's own UI inside the Agents Window. It is three
small files and one decision, and the decision is the part worth reading.

## The decision

**The seam is the runtime's pairing + RPC surface, not Electron IPC.**

Everything follows from that. The web client reaches the runtime over a socket
it pairs with; it does not know or care whether the runtime is a child process,
a remote host, or something living in this window. So the runtime can move later
without the UI changing, and three roadmap items stop competing for the same
slot:

| What | Talks to | Status |
| --- | --- | --- |
| This window | the pairing + RPC surface | done |
| The SvelteKit client (`web/`, Phase 1) | the same surface | independent |
| An in-process backend (Phase 4) | implements the same surface | later, invisible to both |

## Why not run the vendored backend

`kingu-orca/` holds the ADE's entire main process, bundled and building. It is
not what runs here, and its own `MERGE.md` says why:

> Nothing calls this yet. `main/index.ts` owns an application lifecycle: it
> creates its own `BrowserWindow`, its own daemon, its own tray. The fork's main
> process already owns those, so the seam cannot be "run their `index.ts`".

The bundle starts executing and halts on a stubbed `app.getPath()`. Reaching
past the entry point into `main/ipc` and `main/runtime` is a real option — it is
the one `MERGE.md` proposes — but it is a large piece of work whose cost nobody
has measured.

`kingud` is the same backend with that problem already solved upstream: an
Electron-free build, **"zero electron and node:sqlite imports"**, driving nothing
but the public pairing + RPC surface. It is the acceptance target of the ADE's
own `runtime-serve-terminal-smoke` script. So this runs that.

## What happens when you open the workbench

1. `KinguRuntimeServer` spawns `kingud.js --port 0 --json` and waits for its
   `kingu_server_ready` line, which carries the socket and a pairing offer.
2. It serves the built web client from loopback on an OS-chosen port. The
   runtime does not serve it — its ready payload reports `webClientUrl: null` —
   and it cannot be loaded from `file:`, because it is an ES-module bundle that
   fetches its own chunks.
3. The command opens `web-index.html?code=<pairing code>` in a
   `BrowserEditorInput`. The client imports a `runtime`-scoped offer without
   asking and strips the query from its address bar, because the payload carries
   the runtime's auth token. Nobody is shown a "Connect to Kingu" form for a
   server this window started on loopback seconds ago.

Both are torn down with the channel. `SIGTERM` first so the runtime can close
its own terminal daemon: a daemon orphaned by `SIGKILL` outlives the window and
holds the next run's port.

## The pairing code, not the pairing URL

The runtime prints `kingu://pair?code=<base64url>`. The web client's parser only
strips an `orca://` prefix — a miss from the rebrand — so handing it the whole
URL fails to decode, and pasting what the server printed into the Connect box
does not work. `pairingCodeFromUrl` takes the bare code, which is also what the
client's `?code=` startup path expects. Worth fixing upstream; harmless here.

## Where the build comes from

Two settings, `kingu.runtime.entry` and `kingu.runtime.webRoot`, defaulting to a
`kingu-intelligence` checkout beside this one. Paths rather than a vendored copy
on purpose: both repositories are moving together, and a stale bundled runtime
is worse than a path that is occasionally wrong. Build them with
`pnpm run build:kingud` and `pnpm run build:web`.
