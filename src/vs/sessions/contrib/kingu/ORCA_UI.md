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
   already present here. *Stats & Usage is now built — see below. Skills is now
   built, read-only — see below. Activity is now built — see below.*
2. **The Agents sidebar body.** The ADE's sidebar switches between `workspaces`
   and `agents`; the second aggregates live agent rows across every worktree
   with read/unread, grouping and filtering. This window has the sessions list,
   which is most of it, grouped differently. *Now built as a second sidebar view
   — see below.*
3. **Inline agent rows on the worktree card** (`WorktreeCardAgents`) — a
   worktree's live agents as child rows under it. *Already native here:* the
   sessions list is a tree, and a session with more than one chat is a
   collapsible parent with a `SessionChatItem` row per chat (its own status
   dot, title, approval and worktree badge; `sessionsList.ts`,
   `toSessionChildren`). What differs from the ADE is deliberate upstream
   filtering in `getSessionListChats`: subagent (`ChatOriginKind.Tool`) and
   side chats are not listed, where the ADE nests subagents under their
   parent. Showing them would need a third tree level and touches the core
   list, so it is left as a decision, not a gap.
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

- **The Skills page.** The ADE's `skills/` is 85 files and 9,840 lines, and only
  a fifth of it is the page: the rest installs, shares, bundles and
  version-checks skills against its cloud. What ported is the part that answers
  the question the page exists for — *is this skill installed, and which agent
  can see it* — as the roots table (`kinguSkillSources.ts`), the front-matter
  reader (`kinguSkillMetadata.ts`) and the filter (`kinguSkillFilter.ts`), with
  the walk rewritten onto `IFileService`. The ADE's second discovery path, a
  `find -maxdepth` run inside a WSL distro, is not here: its renderer cannot see
  that filesystem and this one can, through the same file service.

  Deliberately not ported yet: install, share, bundle and freshness. Those are
  cloud-backed, and a button that looked like it worked would be worse than its
  absence.

- **The Activity page.** 6,231 lines in the ADE, and the ratio is the most
  extreme of any of these: almost none of it is the page. `activity-portal-*`,
  `activity-terminal-portal-*`, `activity-event-builder*`, `activity-event-cap`
  and the retained-snapshot machinery exist because an agent running as a CLI in
  a PTY cannot be asked what it is doing. The ADE fans in hook snapshots per
  pane, caps them per pane so one noisy pane cannot hide another, retains them
  across restarts, and reconciles portals against readiness. Every one of those
  problems is created by the PTY, and this window does not have it: a session
  reports its own status over the protocol.

  What ported is the part that makes Activity a *different surface from a list
  of sessions* — `ACTIVITY_STATUS_GROUP_RANK`, the attention-first ordering — plus
  group-by, the search-text cache keyed on row identity, and the query cap. The
  sessions list groups by workspace, date, pins and custom groups; none of those
  put "needs input" above "done". That is the whole of what this page adds.

  Deliberately not ported: **clear completed**. In the ADE it stamps a per-pane
  cutoff over retained snapshots and offers an undo, because those rows live
  only in its own memory. The equivalent act here is archiving a session, which
  the sessions list already owns and which is real rather than a local hide.

- **The Agents sidebar view.** `SidebarAgentsList.tsx` says in its own comment
  what it is: "The Activity thread list, hosted in the sidebar as a navigator."
  So it is not a second feature — it is the Activity model in a narrower frame,
  and here it imports the same `common/kinguActivity.ts` the page does. One
  ranking, one grouping, one search; the sidebar and the page cannot disagree
  about what a session is doing. What it adds over the page is the ADE's
  `ThreadReadFilter` (all / unread), compact rows, and mark-all-read.

  Two things about where it is registered, both learned the hard way:

  - **It has to live in the sessions container.** The first attempt gave it a
    container of its own, which is what an ordinary VS Code window would want.
    It was unreachable: this window omits the Activity Bar, so there was nothing
    to click, and no `View:` command is generated for a container. `LAYOUT.md`
    already said the answer — the sidebar is "Sessions list and Sessions-owned
    sidebar views".
  - **It declares no `order`.** An explicit order sorted it *above* the sessions
    list, because the sessions view declares none and an unordered view sorts
    after an ordered one. With both unordered it falls back to registration
    order, and `sessions.contribution.js` is imported first.

  **The one visible cost:** the sessions container is registered with
  `mergeViewWithContainerWhenSingleView`, so it has no header today. A second
  view stops that merge, and the sidebar now shows a `SESSIONS` header above the
  list. That is VS Code behaving as designed, but it is a change to a surface
  this port was not asked to touch, and it is the reason to keep the Agents view
  collapsed by default.

- **Task detail and Start workspace.** The ADE has one item dialog or drawer
  per provider (GitHub, GitLab, Jira, Linear), each with its own IPC and its
  own comment shape. What ported is `common/kinguTasksDetail.ts`: the calls
  each provider needs, one reader that turns every answer into the same
  body / comments / facts, and the ADE's start prompt (`Complete <url>` for the
  repo hosts, the link as context for Jira and Linear). The page draws that
  one shape, in place of the list, which stays alive behind it so Back keeps
  the query and page.

  Start workspace does not build a workspace itself. It closes Tasks and hands
  the prompt and the project folder to the Agents composer through
  `AgentsWindowWorkspaceHandoff`, the same path "Continue in Agents" uses. The
  reader then picks the agent and the worktree and presses send. The handoff
  keeps a draft the reader was already writing. Here the reader asked for
  this task, so the launcher opens the new-session page itself, puts the
  prompt in over the old text, and offers "Restore Earlier Draft". The
  launcher is a service, not part of the page: hiding a custom view disposes
  it, and the handoff has to outlive that. The ADE's name seed
  and PR-head checkout are not ported: this composer names sessions itself and
  isolates by worktree.

  The ADE refuses a detail read for a path it does not know as a project
  ("Access denied: unknown repository path"). That is on purpose, so a row
  can only open a task from a project the ADE already has.

The lesson all five times: **take the model, leave the React.** The React is
the cheapest part to rewrite and the least worth keeping — and on Activity, so
is most of the logic under it.

### What the ported skill reader got wrong twice

Both were in the ADE's own logic, and both only showed up once there were tests
on the port:

- **A fenced block is not a description.** `firstParagraph` skipped the line
  with the ``` on it and then took the next one, so a skill whose body opens on
  a usage block was described to the user as `npm run deploy` — a shell command
  presented as a sentence about what the skill does. The fence is now tracked,
  not merely recognised.
- **Empty front matter is still front matter.** The delimiter pattern required a
  newline *inside* the block, so a `SKILL.md` opening `---\n---` fell through to
  the body reader and the page described the skill as `--- ---`.

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
