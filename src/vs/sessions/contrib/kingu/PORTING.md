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
| `memory` | `kinguHostChannel._getMemoryBytes` | Total plus a breakdown by process kind. |
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

1. **Usage attribution.** The ADE's `usage/` and `claude-usage/` attribute
   spend to a worktree and price it per model. Here `getUsageSummary` totals
   tokens by agent and no further. Pricing is the easy half; attributing a
   transcript to the worktree it ran in is the half that is worth something.
2. **Advertised URLs for ports.** The ADE watches a dev server's output for
   the URL it prints, so the ports list offers `http://localhost:5173/` rather
   than a number and a guess. Here the port entry assumes loopback and `http`.
3. **A Windows remote host.** Remote roots are built from the host's own
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
