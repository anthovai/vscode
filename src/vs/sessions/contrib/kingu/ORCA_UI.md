# The ADE's UI, surveyed

A read of the ADE's renderer against this window, to answer one question: where
does the Agents Window actually behave differently, and which of those
differences are worth closing.

## What is there

`src/renderer` is 10,101 TypeScript files. Only 2,458 of them are `.tsx`; the
other 7,643 are logic that happens to live under `components/`. That ratio is
the single most useful fact in this document — **most of the ADE's UI is not
UI**, and the part that carries the decisions ports cleanly into a stack with no
React in it.

| Directory | `.tsx` | `.ts` | What it is |
| --- | ---: | ---: | --- |
| `settings/` | 292 | 184 | The settings surface, twenty-odd pages |
| `sidebar/` | 176 | 326 | Projects → worktrees, the worktree card, the Agents list |
| `right-sidebar/` | 153 | 320 | Explorer, source control, checks, ports, session history |
| `editor/` | 89 | 307 | The embedded editor |
| `automations/` | 57 | 124 | Scheduled agent runs |
| `native-chat/` | 53 | 155 | The non-PTY chat surface |
| `browser-pane/` | 50 | 138 | `<webview>` panes an agent can drive |
| `terminal-pane/` | 24 | **458** | The PTY pane — almost entirely logic |
| `task-page/`, `stats/`, `skills/`, `artifacts/`, `mobile/`, … | | | One page each |

## The shell

`AppWorkspaceShell.tsx` is the whole layout in one file:

```
titlebar
├── Sidebar (projects → worktrees, or the Agents list)
├── TerminalWorkbenchContainer → Terminal → per-worktree split surfaces
│     └── ActivePage: settings | skills | artifacts | tasks | automations | activity | space | mobile
└── RightSidebar (explorer | vault | worktrees | pr-checks | source-control | checks | ports | plugins)
```

`activeView` selects the centre. `'terminal'` is not a page — it is the
workbench, and every other value replaces it.

## The one structural difference

**In the ADE a worktree owns a workbench of panes. In this window a session owns
a conversation.**

The ADE's centre is `WorktreeSplitSurface`: per worktree, a split layout of tab
groups, each tab a terminal, a browser or an editor, all of them kept mounted
across worktree switches (the file carries a comment about an IPC storm from
remounting them). An agent there *is a CLI in a PTY*, and its status is
published by a hook the ADE injects into that agent's own configuration.

This window's centre is a chat with an SDK-backed provider. That is why a PTY
workbench is not a feature to port but a different foundation — and the trade
was already recorded: three providers speaking a real protocol against the
ADE's eighteen driven through a terminal.

Everything else below is smaller than this looks.

## Where the models already agree

The state model is nearly the same, which is why most surface differences are
presentation rather than architecture:

| The ADE | This window |
| --- | --- |
| `working` | `SessionStatus.InProgress` |
| `waiting` / `blocked` | `SessionStatus.InputNeeded` |
| `done` | `SessionStatus.Idle` |
| acknowledged-at per pane | `SessionStatus.IsRead` |
| `AgentType` (open string) | session provider |
| worktrees in the sidebar | worktree grouping in the sessions list |

The ADE derives its states from hooks it writes into each agent's config, and
says so in a comment: *status comes from hooks — never inferred from terminal
titles*. This window gets the same states from the protocol, for free.

## The real gaps, ranked

1. **Whole pages this window does not have.** Stats & Usage, Tasks, Artifacts,
   Skills, Mobile, Activity. Each is self-contained and each has its data
   already present here. *Stats & Usage is now built — see below.*
2. **The Agents sidebar body.** The ADE's sidebar switches between `workspaces`
   and `agents`; the second aggregates live agent rows across every worktree
   with read/unread, grouping and filtering. This window has the sessions list,
   which is most of it, grouped differently.
3. **Inline agent rows on the worktree card** (`WorktreeCardAgents`) — a
   worktree's live agents as child rows under it.
4. **The per-worktree workbench.** The structural difference above. Not a port.

## How the porting actually goes

Two done so far, and both went the same way, which is worth recording as the
method:

- **The Usage panel.** The ADE's `UsageRosterPanel.tsx` is 347 lines of React.
  Under it sit four modules of pure logic — worst-row ordering, what a row says
  with no number, where a bar changes colour, how a percentage rounds. Those
  ported; the drawing was rewritten against this fork's DOM helpers and hung off
  a status bar entry's own element-factory tooltip. No popover framework.
- **The Usage page.** Same split. The ADE's page opens on three *Enable Claude /
  Enable Codex / Enable OpenCode* buttons because it has to be told to scan each
  agent's logs into its own ledger. The vault here has already read every
  session on the machine, so the page opens on numbers: 554 transcripts, live
  progress, then cards, a token mix, a row per agent and six weeks of days.

The lesson both times: **take the model, leave the React.** The React is the
cheapest part to rewrite and the least worth keeping.

### Two things the real data corrected

Running the page against this machine's vault caught two places where the
ported shape was not yet honest:

- `>99%` and `<1%`, not `100%` and `0%`. Cache reads are 99.99% of everything
  sent here. Rounding printed `100%` — which claims nothing was ever sent fresh
  — while the 1.3M tokens that *were* sent fresh printed `0%`. Same mistake
  `formatCostUsd` already avoids with `<$0.01`.
- The cost caption. The figure is four digits, and almost everyone reading it is
  on a subscription where those tokens cost a flat monthly fee. "List prices"
  left the inference to the reader, and the inference people draw from a
  four-figure number is that they owe it. It now says what it is: what the work
  would list at on the API, not what a subscription was charged.
