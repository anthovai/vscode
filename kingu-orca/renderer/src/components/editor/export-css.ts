// Why: this stylesheet targets the *exported* PDF document, not the live Kingu
// pane. In-app CSS assumes sticky UI chrome, hover affordances, and app-shell
// spacing that would look wrong when flattened to paper. Keeping export CSS
// separate also means a future UI refactor can move live classes without
// silently breaking PDF output.
export const EXPORT_CSS = `
* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: #ffffff;
  color: #1f2328;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial,
    sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
  font-size: 14px;
  line-height: 1.6;
}

.kingu-export-root {
  padding: 0;
  max-width: 100%;
}

.kingu-export-root h1,
.kingu-export-root h2,
.kingu-export-root h3,
.kingu-export-root h4,
.kingu-export-root h5,
.kingu-export-root h6 {
  font-weight: 600;
  line-height: 1.25;
  margin-top: 1.5em;
  margin-bottom: 0.5em;
}

.kingu-export-root h1 { font-size: 1.9em; }
.kingu-export-root h2 { font-size: 1.5em; }
.kingu-export-root h3 { font-size: 1.25em; }
.kingu-export-root h4 { font-size: 1em; }

.kingu-export-root p,
.kingu-export-root blockquote,
.kingu-export-root ul,
.kingu-export-root ol,
.kingu-export-root pre,
.kingu-export-root table {
  margin-top: 0;
  margin-bottom: 1em;
}

.kingu-export-root a {
  color: #0969da;
  text-decoration: underline;
}

.kingu-export-root blockquote {
  padding: 0 1em;
  color: #57606a;
  border-left: 0.25em solid #d0d7de;
}

.kingu-export-root code,
.kingu-export-root pre {
  font-family: "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.9em;
}

.kingu-export-root code {
  background: #f6f8fa;
  padding: 0.2em 0.4em;
  border-radius: 4px;
}

.kingu-export-root pre {
  background: #f6f8fa;
  padding: 12px 16px;
  border-radius: 6px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.kingu-export-root pre code {
  background: transparent;
  padding: 0;
  border-radius: 0;
  font-size: inherit;
}

.kingu-export-root table {
  border-collapse: collapse;
  width: 100%;
}

.kingu-export-root th,
.kingu-export-root td {
  border: 1px solid #d0d7de;
  padding: 6px 12px;
  text-align: left;
}

.kingu-export-root th { background: #f6f8fa; }

.kingu-export-root img,
.kingu-export-root svg {
  max-width: 100%;
  height: auto;
}

.kingu-export-root ul,
.kingu-export-root ol { padding-left: 2em; }

.kingu-export-root li { margin: 0.25em 0; }

.kingu-export-root input[type="checkbox"] {
  margin-right: 0.4em;
}

.kingu-export-root hr {
  border: 0;
  border-top: 1px solid #d0d7de;
  margin: 1.5em 0;
}

/* Why: the export subtree selection already excludes the big chrome (toolbar,
   search bar, etc.), but in-document affordances like the code-copy button
   and preview annotation controls can still leak. Hide the well-known
   offenders as a belt-and-suspenders defense on top of DOM scrubbing. */
.code-block-copy-btn,
.markdown-preview-search,
.markdown-annotation-controls,
.rich-markdown-toolbar,
[data-kingu-export-hide] {
  display: none !important;
}

.code-block-wrapper { position: static !important; }

@media print {
  pre, code, table, img, svg { page-break-inside: avoid; }
  h1, h2, h3, h4, h5, h6 { page-break-after: avoid; }
}
`
