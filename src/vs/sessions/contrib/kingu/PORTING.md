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
| `preflight/agent-detection` | `platform/kinguHost/common/kinguAgentCommands.ts` | Which agent CLIs are installed, using the fork's own shell-environment resolver for PATH. |
| `stats` | `common/kinguStats.ts` | Counters rather than an event log, fed from each session's own status observable. |
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

## Solved differently, and better

The single largest thing in the ADE's main process, and the clearest case for
not porting any of it.

`claude/` (84 files), `codex/` (192), and the smaller `gemini/`, `grok/`,
`kimi/`, `cursor/`, `devin/`, `droid/`, `hermes/`, `pi/`, `antigravity/`,
`copilot/`, `opencode/`, `amp/`, `mimo/`, `minimax/`, together with
`agent-hooks/` (141) — **722 files** — are all the same thing: a hook service
per agent. The ADE runs each agent's CLI in a PTY, and a CLI in a PTY cannot
tell anyone what it is doing, so the ADE writes its own hook or plugin into
that agent's own configuration (`~/.claude` hooks, Gemini's `hooks.json`, an
Amp plugin file, a Hermes plugin, an OpenCode status plugin, a Pi titlebar
extension) and has the agent report back.

This window has the Agent Host Protocol: a real bidirectional protocol with the
agent, which is where `ISession.status` comes from and therefore where the
statistics above come from. None of those 722 files has anything to add to it.

Porting them would also mean this app writing into other tools' configuration
files to make them talk to us — the same class of act as writing into their
credential stores, which is declined above for the same reason.

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

1. **PR counting.** The ADE's stats include `pr_created`, deduplicated by URL
   across restarts. Not ported: it needs a hook on pull-request creation that
   this window does not have yet, and inventing a weaker signal would produce a
   number that is quietly wrong rather than absent. The fork does have
   `agentHostPullRequestOperationHandler`, so the hook is reachable — it just
   has not been wired.
2. **An actual Windows remote host.** The Windows *path* handling is fixed and
   tested — see below — but no test has connected to a machine running Windows,
   because standing one up here needs an elevated install of OpenSSH Server.
   What is untested is the fork's own SSH transport and CLI bootstrap against a
   Windows sshd, not the vault code that runs on top of it.

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

## Windows paths on a remote host

A URI with an authority — which is every remote resource — must have a path
beginning with a slash, and `URI.with` throws when it does not. A Windows
host's `C:\code\app` satisfies neither half of that, so every attempt to build
a sibling resource from a Windows working directory raised `UriError`. Local
`file:` URIs happen to tolerate the bare form, which is why it never showed up
until attribution started resolving `.git` beside a session's directory.

It would not have been one broken row. The throw happened inside the bounded
fan-out that reads every session, so one Windows-recorded session anywhere in
the vault would have rejected the whole usage report. Two changes: host paths
are converted to URI paths before a resource is built, and an unresolvable
directory is caught and reported as a plain directory rather than taking the
report with it.

Verified with a session recorded under `C:\code\ledger-win`, read over the SSH
host:

```
ledger-win  $0.06 · 3.0k  directory · kingu-remote-test:C:\code\ledger-win · 1 session
```

The report completed, the path is shown the way the machine that owns it writes
it, and nothing was logged as unattributable.

## Which agents are installed

The vault answers "what have I run". This answers "what could I run", and the
two together are what make a list of eighteen agents mean anything: an agent
with sessions and no CLI is one the user has moved away from, a CLI with no
sessions is one they installed and never used, and neither is visible from
either half alone.

Detection is a directory listing, not an execution. Running each candidate with
`--version` would be a surer answer and would also mean this app spawning a
dozen third-party binaries whenever somebody opened a list, so what is reported
is presence on disk — reported as presence, not as "working".

PATH comes from the fork's own `getResolvedShellEnv`, which is already used for
this exact reason: a desktop app on macOS or Linux is started by the session
manager and never sees the login shell's PATH, so an agent installed by a
version manager is invisible to `process.env`. The ADE carries its own
shell-PATH hydration for the same problem; this uses the window's.

A row that finds nothing names the command it looked for, because "not found"
beside an agent the user demonstrably has reads as a bug. On this machine:

```
Claude       installed C:\Users\aidev\AppData\Roaming\npm\claude.cmd · 398 sessions
Gemini       installed C:\Users\aidev\AppData\Roaming\npm\gemini.cmd · 2 sessions
Cursor       not found cursor-agent · 97 sessions
Codex        not found codex · 50 sessions
```

Both "not found" rows are correct, and both are the interesting case: Codex was
used fifty times and its CLI is gone, while Cursor's ninety-seven sessions came
from the editor, which is installed — `cursor-agent`, its CLI, is not. Naming
the command is what lets a reader tell those apart.

## Agent statistics

The one question the vault cannot answer. It reads transcripts other agents
left behind, so it knows what was said and never how long anything took or how
often a run happened — that is only observable while it happens.

Counters, not an event log. The ADE keeps every event and derives its
aggregates from them, bounded at ten thousand entries, with a schema version, a
loader, a snapshot writer and a field that exists solely because trimming the
log would otherwise move the "tracking since" date. Two numbers and a date
answer what the feature is for, cannot be trimmed into being wrong, and go
through `IStorageService` — so none of that machinery is written here.

The boundaries come from each session's own `status` observable, which is the
same value the list and the icons read, so a number here cannot disagree with
what the user is looking at. Only `InProgress` is counted: `NeedsInput` is the
session waiting on a person, and counting it would turn "three hours of agent
work" into "three hours with a tab open".

What did need writing is the mirror. A status observable re-fires for things
that are not transitions — a re-render, a reconnect replaying the last state, a
title change — so `KinguRunTracker` holds the last state per session and treats
a repeat as nothing. Without it every number inflates. The ADE has the same
component for the same reason, against its agent-hook stream.

A session that goes away closes its run rather than losing it, and a window
that is closing counts what is still open at its length so far.

### Verified, and not

The tracker's contract is covered: repeats, restarts, independent sessions, a
session first seen already finished, a clock that went backwards, eviction, and
the persistence round trip including a stored shape that does not parse.

The live wiring is not. Seeing a run counted end to end means an agent
completing a turn, which spends the user's quota, so what was checked against
the running window is the empty state — "nothing counted yet" — and that the
service loads and watches without error.

## The whole inventory

The ADE's `src/main` is 9,072 TypeScript files across about ninety
directories. Every one was opened. Where they landed:

**Ported** — `ai-vault`, `ai-vault-search`, `rate-limits`, `claude-usage`,
`codex-usage`, `usage`, `ports`, `memory`, `preflight`, `stats`.

**Solved differently** — the 722 files of per-agent hook services, above.

**Already in the fork, natively** — `git` (77), `github` (57), `gitlab` (35),
`gitea`, `bitbucket`, `azure-devops`, `source-control` (20); `jira` (23),
`linear` (45); `pty` (25), `ghostty`; `ssh` (166), `wsl`, `runtime` (595);
`browser` (323), `plugins` (68), `skills` (98), `automations` (33);
`window` (43), `windows`, `menu`, `keybindings`, `i18n`, `tray`, `dock`,
`updater` (16), `notifications`, `speech` (24), `telemetry`,
`crash-reporting` (28), `observability` (12), `network`, `persistence`,
`sqlite`, `startup` (68), `ipc` (439), `lib`.

**Shaped by the ADE being its own application, with no counterpart here** —
`kingud` (26, a headless Node host), `daemon` (209), `server`, `emulator` (23),
`warp-themes` (12), `star-nag` (11), `local-builds`, `kingu-profiles` (36),
`hang-watchdog`, `diagnostics`, `host`, `cli` (33), `native-chat` (50),
`project-groups`, `providers` (104, how a CLI is spawned — the agent host owns
this here), `agent-launch`, `command-code`.

**Real capability we do not have, and a product decision rather than a port:**

- `computer` (34 files) — computer use: a desktop script runtime, screenshots,
  clicks, clipboard validation. A large surface with real risk, and nothing in
  this window corresponds to it.
- `text-generation` (17) — commit messages and pull-request descriptions
  generated by a local or remote model, with concurrency lanes and limits. The
  fork generates commit messages in its git extension, so the uncovered half is
  the PR description written from a session's own changes.
- `artifacts` (6) — publishing and sharing an artifact through a cloud service.
