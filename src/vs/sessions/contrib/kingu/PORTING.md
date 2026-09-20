# What came across from the ADE, and what did not

The Kingu ADE (`kingu-intelligence`, an Electron + React app) and this VS Code
fork solve overlapping problems. This is the survey of the ADE's `src/main`
feature areas against what the Agents Window already has, so the next person
does not re-derive it — and so the parts that were deliberately *not* ported
are on the record with their reasons rather than looking like oversights.

Read the verdicts as: **ported** (it is in `contrib/kingu` or
`platform/kinguHost` now), **already here** (the fork has its own, better
integrated), **not worth porting** (the fork's architecture makes it moot, or
it is a cost we do not want), **open** (a real gap, not yet done).

## Ported

| ADE area | Here | Note |
| --- | --- | --- |
| `ai-vault` | `contrib/kingu/common/kinguVault*.ts` | 18 agents as a declarative table, scan + describe + delete + subagents. |
| `ai-vault` remote scanning | `common/kinguVaultRemote.ts` | The ADE needed a second SFTP walker and a second set of parsers; here a connected host already serves its filesystem to `IFileService`, so only the root differs. |
| `ai-vault` parse cache | `common/kinguVaultCache.ts` | Same posture as the ADE's `remote-session-parse-cache`: LRU keyed by path, validated by mtime + size. |
| `ai-vault-search` | `KinguVaultService.search` + `common/kinguVaultSearchBudget.ts` | The ADE indexes into SQLite in a child process. Here it is a bounded walk with a per-host read allowance. See *Search* below. |
| `rate-limits`, `claude-usage`, `codex-usage` | `platform/kinguHost/` | Quota per provider, read in the main process because a renderer cannot reach these endpoints and should never hold the token. |
| `ports` | `platform/kinguHost/common/kinguHostPorts.ts` | Scoped to this app's process tree, which is what makes the count readable. |
| `ports/advertised-url-*` | `common/kinguAdvertisedUrls.ts` | Read from the terminal's own line events, so the ADE's PTY buffering and ANSI stripping are not needed — see *Advertised URLs* below. |
| `memory` | `kinguHostChannel._getMemoryBytes` | Total plus a breakdown by process kind. |
| `claude-usage`, `codex-usage` pricing | `common/kinguPricing.ts` | Both price lists, each with its own token semantics — see *Pricing* below. |
| `usage/` worktree attribution | `common/kinguVaultAttribution.ts` | Resolved from git itself rather than from a worktree registry the ADE keeps. |
| `ssh`, `wsl`, `runtime` | — | Satisfied by the fork's own `IRemoteAgentHostService`; see below. |

## Already here, and better

The fork carries these natively, wired into the workbench rather than bolted
onto it. Porting the ADE's version would mean running two of each.

- **SSH / WSL / dev containers / tunnels** — `platform/agentHost` has an SSH
  client with host-key verification and `known_hosts`, `~/.ssh/config`
  parsing, a CLI bootstrap on the remote, and a filesystem provider per
  connection. The ADE's `ssh/`, `wsl/` and `runtime/` are its own versions of
  this.
- **Terminals and PTYs** (`pty/`, `ghostty/`) — `workbench/contrib/terminal`.
- **Git and forges** (`git/`, `github/`, `gitlab/`, `gitea/`, `bitbucket/`,
  `azure-devops/`, `source-control/`) — the `git` and `github` extensions and
  `workbench/contrib/scm`.
- **Issue trackers** (`jira/`, `linear/`) — extensions, which is where an
  integration with someone else's API belongs.
- **Plugins, skills, automations, hooks** (`plugins/`, `skills/`,
  `automations/`, `agent-hooks/`) — `contrib/automations`,
  `contrib/aiCustomizationTreeView`, and the extension host.
- **Updater, tray, dock, menu, keybindings, notifications, i18n, telemetry,
  crash reporting, persistence, sqlite, speech, browser** — every one has a
  workbench or platform equivalent already in use by this window.

## Not worth porting

- **`ai-vault-search`'s SQLite index.** The ADE runs a full-text index in a
  child process, reconciled against the corpus. It buys sub-second search over
  a large corpus; it costs a database of the user's own prompts on disk, a
  schema to migrate, and a process to supervise. This fork's vault is
  deliberately in-memory for the same reason it is not persisted: these files
  are the user's working history and a copy of them is something they did not
  ask for. The bounded walk searched 325 of 537 local sessions in about five
  seconds, which is the right trade at this size. If a corpus ever makes that
  false, the index goes behind a setting, not in by default.
- **`emulator/`, `warp-themes/`, `star-nag/`, `local-builds/`, `kingud/`,
  `daemon/`, `server/`** — ADE-shaped concerns with no counterpart here.
- **Account *switching*** (`claude-accounts/`, `codex-accounts/`,
  `grok-accounts/`). Reading a quota from a credential the agent's own CLI
  stored is one thing; writing to those credential stores to switch accounts
  is another, and this app does not own them.

## Open

Real gaps, in the order they seem worth closing.

1. **A Windows remote host.** Remote roots are built from the host's own
   `defaultDirectory` and joined with forward slashes, which a Windows host
   accepts — but every remote test so far has been against Linux.

## Search

Worth stating plainly, because it is the biggest structural difference.

The ADE searches an index. This searches the files, with a budget per machine:
the local disk gets 8 MB per transcript and no total, a host reached over the
agent connection gets 512 KB per transcript, 64 MB in total and fewer reads in
flight, because each of those reads is a round trip on a link the agent is
also using. Every machine walks at the same time, so a slow host delays only
its own half of the answer.

The honest consequence is that a remote search can miss a match deep inside a
very long transcript. That is why a search reports where it stopped —
`complete`, `maxResults`, `budget` or `cancelled` — and the picker says so. A
partial answer presented as a whole one would be worse than a slower search.

## What the end-to-end test against a real host found

A throwaway SSH host (a container on loopback, seeded with Claude and Codex
transcripts) was connected through *Connect to Remote Agent Host via SSH*. What
it proved, and what it broke:

- The scan reads a remote transcript once and reuses it after — including
  across a disconnect and reconnect, where the second scan read nothing at all.
- Search finds a phrase that exists only on the remote host, with the matching
  line as its excerpt.
- Deleting a remote session removes the file on the host. It also exposed two
  things the local path had been hiding: the confirmation drew the path with
  `fsPath`, so a Linux host's `/home/dev/…` appeared with backslashes, and it
  promised a recycle bin that a remote host does not have. Both are fixed; a
  remote delete now says which machine and that it is outright.

## Pricing and attribution

Two price lists, because the two providers count differently and reading one
as the other is wrong by a multiple. Claude reports cache reads apart from
input; Codex's `input_tokens` *includes* the cached ones, so its uncached input
has to be derived or every cached token is billed twice. Each list also tiers
long context per bucket rather than per total.

Both are lists maintained by hand, so a cost is always an estimate, and a model
no list knows is reported as unpriced rather than as zero — a zero would read
as "this was free", which is the one wrong answer that looks like an answer. A
row is priced only when every model that actually spent tokens in it is priced.
Models that moved no tokens are ignored, which is what lets a real session be
priced at all: Claude Code files its own non-model records under `<synthetic>`.

Attribution asks git rather than keeping a registry. A session's working
directory is walked up for a `.git`; a directory there is a checkout and a file
there is a linked worktree whose pointer names the repository that owns it.
That distinction is git's own, so a worktree is reported as one, named after
both the repository and the branch, and totalled apart from the checkout —
which is the question worktrees exist to make askable. A directory in no
repository attributes to itself rather than to a parent, because a parent would
put unrelated projects in one row.

Verified against a real repository and a real linked worktree on the SSH host:

```
ledger-api · reconcile-fix  $4.72 · 208.0k  worktree   · kingu-remote-test:/home/dev/worktrees/reconcile-fix · 2 sessions
ledger-api                  $1.91 ·  54.0k  repository · kingu-remote-test:/home/dev/ledger-api             · 1 session
ledger-api                  $0.09 ·   4.0k  directory  · kingu-remote-test:/srv/ledger-api                  · 3 sessions
```

Three rows, two of them sharing a label. The kind, the machine and the path are
all in the row because without them a report that spans hosts is a total of the
wrong thing.

## Advertised URLs

A port number cannot be opened. A dev server's scheme, the hostname it chose
and the path it serves from are all stated exactly once — in the line it prints
when it comes up — and nowhere else. So that line is what is read.

The ADE does this from raw PTY chunks: it buffers them, strips ANSI, OSC and
cursor movement, and reassembles URLs split across writes. None of that is here
because the terminal in this window emits `onLineData`, which is already
unwrapped and already stripped. That is the whole of the difference, and it is
most of the ADE's module.

Which address wins, when a server announces several: a name the project
arranged for, then loopback, then a LAN address, then a public one — a name
because its certificates and cookies are issued against it, loopback because
this machine is the one asking. `https` beats `http` from the same server, and
otherwise the newer announcement wins, because a restart is news. A bind-
everything address is rewritten to loopback: `http://0.0.0.0:3000` is what the
server bound to, not somewhere to go.

Nothing is persisted, and an address is dropped as soon as its port stops
listening. The line stays in the scrollback after the process is gone, so
without that the next server on that port would inherit the last one's URL and
path.

Verified by running a server that announces itself the way Vite does, in a
terminal of this window:

```
5173 node.exe · http://localhost:5173/app/
```

— the Local address chosen over the Network one it printed beside it, the path
kept, and the whole entry gone once the server was killed.
