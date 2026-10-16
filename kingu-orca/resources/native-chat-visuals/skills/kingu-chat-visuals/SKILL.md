---
name: kingu-chat-visuals
description: Show a chart, diagram, table, report or mockup inline in this Kingu chat as an HTML
  page. Use when a visual would help the user understand your answer. Only available when the
  KINGU_CHAT_SCRATCH_DIR environment variable is set.
user-invocable: false
---

# Inline visuals in an Kingu chat

Kingu can show an HTML page inside your reply. Use one whenever a visual would make the answer
clearer.

## Writing the page

- Save it in the folder named by `KINGU_CHAT_SCRATCH_DIR` (`printenv KINGU_CHAT_SCRATCH_DIR`; in
  PowerShell `$env:KINGU_CHAT_SCRATCH_DIR`). If it's unset or you can't write there, skip the visual.
  This folder is temporary: Kingu may remove it after 30 days without chat activity or changes.
  Save files meant to last in the workspace.
- One complete HTML file per visual, directly in that folder, under 512 KB, with a new file name
  each time (e.g. `latency-by-region-7c1e.html`): letters, digits, `.`, `_`, `-`, ending in `.html`.
- Inline your styles, scripts and data. Libraries and fonts may load only from cdn.jsdelivr.net,
  unpkg.com, cdnjs.cloudflare.com, esm.sh, fonts.googleapis.com and fonts.gstatic.com. The page
  can't make network requests; use inline SVG or `data:` URLs for images.
- Don't size anything to the viewport height (`100vh`); Kingu fits the frame to your content.
- Optional: Kingu's theme colors are available as CSS variables (`--background`, `--foreground`,
  `--muted-foreground`, `--border`, `--primary`, `--chart-1` to `--chart-5`).

## Showing it

After the file exists, put this on its own line in your reply, outside any code block:

::kingu-visual{file="latency-by-region-7c1e.html" title="Latency by region"}

`file` is the bare file name, never a path; `title` is optional. At most 8 per reply.
