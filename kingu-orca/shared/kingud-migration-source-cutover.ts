/**
 * The client-side journal of a dormant migration from a relay-hosted SSH target into a managed
 * kingud. Kept outside the profile store so an older build rewriting the profile cannot strip it.
 */
import { z } from 'zod'
import {
  MAX_KINGUD_MIGRATION_REPOSITORIES,
  parseKingudMigrationManifest,
  type KingudMigrationManifest
} from './kingud-migration-manifest'
import { isKingudMigrationLocalWslSource } from './kingud-migration-source-kind'

export const KINGUD_MIGRATION_SOURCE_CUTOVER_VERSION = 1
export const MAX_KINGUD_MIGRATION_SOURCE_CUTOVERS = 4

export const KINGUD_MIGRATION_SOURCE_CUTOVER_PHASES = [
  'source-fenced',
  'destination-staged',
  'destination-committed',
  // Written only by earlier builds; read as committed, and nothing writes it now.
  'source-retired'
] as const

export type KingudMigrationSourceCutoverPhase =
  (typeof KINGUD_MIGRATION_SOURCE_CUTOVER_PHASES)[number]

// Why not strict: a newer build's optional field must not make every journal unreadable here.
const CutoverRecordSchema = z.object({
  version: z.literal(KINGUD_MIGRATION_SOURCE_CUTOVER_VERSION),
  migrationId: z.string().min(1).max(128),
  phase: z.enum(KINGUD_MIGRATION_SOURCE_CUTOVER_PHASES),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  destinationEnvironmentId: z.string().min(1).max(256),
  destinationName: z.string().min(1).max(1_024),
  // What the fence binds to: the exact registration and the manifest the destination will see.
  sshTargetId: z.string().min(1).max(1_024),
  sshTargetGeneration: z.number().int().positive(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  // Terminals proven exited before the fence; any other live lease later means work started.
  provenPtyIds: z.array(z.string().min(1).max(256)).max(10_000),
  // COMPAT(legacy-relay-bridge, revisit 2027-01-15): leases converted while their relay may still
  // run them; the bridge serves those panes, so they never read as terminals started under the fence.
  bridgedPtyIds: z.array(z.string().min(1).max(256)).max(10_000).optional(),
  // Committed, with the source rows kept so a downgraded build still sees the host's projects.
  sourceRetainedAt: z.string().datetime().optional(),
  // A delta move after an older build changed the source: the migration it extends, never merges.
  supersedesMigrationId: z.string().min(1).max(128).optional(),
  // What the retained source must still look like; absent means this manifest's own catalog.
  sourceBaselineFingerprint: z.string().min(1).max(64).optional(),
  // Source projects the server already held at the same host path: linked to its rows, not moved.
  linkedRepositoryIds: z
    .array(z.string().min(1).max(1_024))
    .max(MAX_KINGUD_MIGRATION_REPOSITORIES)
    .optional(),
  manifest: z.unknown()
})

export type KingudMigrationSourceCutover = Omit<z.infer<typeof CutoverRecordSchema>, 'manifest'> & {
  manifest: KingudMigrationManifest
}

/** Committed and retained: finished for this build, its source rows kept for a downgrade. */
export function isRetainedKingudMigrationSourceCutover(
  cutover: Pick<KingudMigrationSourceCutover, 'phase' | 'sourceRetainedAt'>
): boolean {
  return cutover.phase === 'destination-committed' && cutover.sourceRetainedAt !== undefined
}

/** Throws on anything that is not exactly a cutover whose manifest matches its binding. */
export function parseKingudMigrationSourceCutover(value: unknown): KingudMigrationSourceCutover {
  const record = CutoverRecordSchema.parse(value)
  const manifest = parseKingudMigrationManifest(record.manifest)
  // An SSH journal binds an SSH manifest; a WSL manifest here is a mismatch, never a fallback.
  const source = isKingudMigrationLocalWslSource(manifest.source) ? null : manifest.source
  if (
    manifest.migrationId !== record.migrationId ||
    manifest.manifestSha256 !== record.manifestSha256 ||
    source?.sshTargetId !== record.sshTargetId ||
    source.sshTargetGeneration !== record.sshTargetGeneration ||
    manifest.destinationEnvironmentId !== record.destinationEnvironmentId
  ) {
    throw new Error('kingud_migration_cutover_binding_mismatch')
  }
  return { ...record, manifest }
}
