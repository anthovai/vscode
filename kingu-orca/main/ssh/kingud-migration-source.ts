/**
 * Where a dormant catalog migrates out of, into a managed kingud.
 *
 * The destination half (catalog stage/commit and the cutover coordinator) reaches a source only
 * through `KingudMigrationSourceCutoverPort`; the conversion drives the rest. The relay-era SSH
 * target (kingud-migration-ssh-relay-source.ts) is the only implementation.
 */
import type { KingudMigrationSourceKind } from '../../shared/kingud-migration-source-kind'
import type {
  KingudMigrationCatalogPayload,
  KingudMigrationManifest
} from '../../shared/kingud-migration-manifest'
import type { KingudMigrationSourceCutover } from '../../shared/kingud-migration-source-cutover'
import type { KingudMigrationManifestExportOptions } from './kingud-migration-manifest-export'
import type {
  KingudMigrationFenceResult,
  KingudMigrationFenceState
} from './kingud-migration-source-fence'
import type { KingudMigrationTerminalVerdict } from './kingud-migration-terminal-gate'

/** What a cutover needs from its source once fenced, keyed by the journaled cutover alone. */
export type KingudMigrationSourceCutoverPort = {
  /** Before every stage and commit; throws unless the fenced source still matches the journal. */
  verifyFence: (cutover: KingudMigrationSourceCutover) => void
  /** Drops the fence, then the journal; only on proof the destination holds nothing. */
  releaseFence: (cutover: KingudMigrationSourceCutover) => Promise<void>
  /** After a proven commit: the source rows stay, hidden, for a downgraded build. */
  retireAfterCommit: (migrationId: string, now?: () => Date) => KingudMigrationSourceCutover
}

export type KingudMigrationFenceAcquireArgs = {
  destinationEnvironmentId: string
  destinationName: string
  /** Taken by `assessTerminals` while the source could still answer. */
  terminalProof: KingudMigrationTerminalVerdict
  now?: () => Date
  signal?: AbortSignal
}

export type KingudMigrationSource = KingudMigrationSourceCutoverPort & {
  readonly kind: KingudMigrationSourceKind
  /** What every journal entry of this source is keyed by. */
  readonly journalKey: string
  /** Scope selection: the catalog rows this source owns. Read-only. */
  collectCatalog: () => KingudMigrationCatalogPayload
  /** The signed manifest, after the source's path-rewrite stage. Read-only. */
  exportManifest: (options?: KingudMigrationManifestExportOptions) => KingudMigrationManifest
  /** Before the fence. Loss of contact is `unverifiable`, never `exited`. */
  assessTerminals: () => Promise<KingudMigrationTerminalVerdict>
  /** Marks what an exited proof covers as ended, so later checks stop counting it. */
  retireProvenExitedTerminals: (proof: KingudMigrationTerminalVerdict) => void
  /** Throws when the journal cannot be read: an unreadable record keeps the source fenced. */
  resolveFence: () => KingudMigrationFenceState
  /** Journal, then fence, then flush, then the terminal re-check under the fence. */
  acquireFence: (args: KingudMigrationFenceAcquireArgs) => Promise<KingudMigrationFenceResult>
}
