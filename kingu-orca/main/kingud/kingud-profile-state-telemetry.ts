import type { ProfileStateStorageClassification } from '../persistence/profile-state/profile-state-storage-classification'

/**
 * The low-cardinality profile-state selection facts that a headless host can publish safely.
 * Paths, profile IDs, and serialized state deliberately stay out of this record.
 */
export type KingudProfileStateAuthoritySelection = {
  backend: 'sqlite'
  classification: ProfileStateStorageClassification
  authority_mode: 'sqlite-established'
  runtime: 'kingud'
  migrated: boolean
}

export type KingudProfileStateTelemetrySink = (line: string) => void

/** Render one machine-readable stderr line for fleet log collection. */
export function formatKingudProfileStateAuthoritySelected(
  selection: KingudProfileStateAuthoritySelection
): string {
  // Keep the wire shape explicit even if a future caller passes a structurally-compatible
  // object with extra runtime fields. Paths, IDs, and serialized state must never leak here.
  return `[kingud-telemetry] ${JSON.stringify({
    event: 'profile_state_authority_selected',
    backend: selection.backend,
    classification: selection.classification,
    authority_mode: selection.authority_mode,
    runtime: selection.runtime,
    migrated: selection.migrated
  })}`
}

/**
 * Publish authority selection without importing Electron or the desktop PostHog client.
 * Logging is best-effort: observability must never prevent an kingud host from serving.
 */
export function emitKingudProfileStateAuthoritySelected(
  selection: KingudProfileStateAuthoritySelection,
  sink: KingudProfileStateTelemetrySink = (line) => console.error(line)
): void {
  try {
    sink(formatKingudProfileStateAuthoritySelected(selection))
  } catch {
    // A closed stderr or custom supervisor sink cannot turn a successful startup into a failure.
  }
}
