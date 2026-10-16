/**
 * The contract between `kingu serve` (CLI) and the app-side entry that decides whether this
 * machine can serve on kingud. The CLI never loads that logic: it runs the packaged app's
 * `out/main/<KINGUD_LOCAL_SERVE_SELECTION_ENTRY>.js` under ELECTRON_RUN_AS_NODE and reads one line.
 */
export const SERVE_RUNTIME_ENV = 'KINGU_SERVE_RUNTIME'
/** `KINGU_SERVE_RUNTIME=electron` keeps `kingu serve` on Electron; kingud is the default. */
export const SERVE_RUNTIME_ELECTRON = 'electron'
export const KINGUD_LOCAL_SERVE_SELECTION_ENTRY = 'kingud/kingud-local-serve-selection-entry'
export const KINGUD_LOCAL_SERVE_SELECTION_FLAGS = {
  userData: '--user-data',
  appRoot: '--app-root'
} as const
const RESULT_MARKER = 'KINGU_SERVE_RUNTIME'

export type ServeRuntimeSelection =
  | { kind: 'kingud'; runtime: string; entry: string; version: string }
  /** `reason` is null when Electron was asked for explicitly, so nothing is printed. */
  | { kind: 'electron'; reason: string | null }

export function formatServeRuntimeSelection(selection: ServeRuntimeSelection): string {
  return `${RESULT_MARKER} ${JSON.stringify(selection)}`
}

/** The last result line in `output`, or null when none parses. */
export function parseServeRuntimeSelection(output: string): ServeRuntimeSelection | null {
  const line = output
    .split(/\r?\n/u)
    .findLast((candidate) => candidate.startsWith(`${RESULT_MARKER} `))
  if (!line) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(line.slice(RESULT_MARKER.length + 1))
    if (!parsed || typeof parsed !== 'object' || !('kind' in parsed)) {
      return null
    }
    const record = Object.fromEntries(Object.entries(parsed))
    if (
      record.kind === 'kingud' &&
      typeof record.runtime === 'string' &&
      typeof record.entry === 'string' &&
      typeof record.version === 'string'
    ) {
      return {
        kind: 'kingud',
        runtime: record.runtime,
        entry: record.entry,
        version: record.version
      }
    }
    if (record.kind === 'electron') {
      return { kind: 'electron', reason: typeof record.reason === 'string' ? record.reason : null }
    }
    return null
  } catch {
    return null
  }
}
