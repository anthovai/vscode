/**
 * Which kind of source a migration manifest moves state out of.
 *
 * The relay-era SSH target is encoded by the ABSENCE of `source.kind`, so its manifests stay
 * byte-identical (and digest-identical) for destinations that predate the field. Every other kind
 * sets `kind` and must never carry `sshTargetId`: an older destination strips unknown fields, so a
 * non-SSH source without it fails that destination's parse instead of importing as an SSH host.
 */
import type {
  KingudMigrationLocalWslManifestSource,
  KingudMigrationManifestSource,
  KingudMigrationSshManifestSource
} from './kingud-migration-manifest'
import { KINGUD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY } from './kingud-runtime-capabilities'

export const KINGUD_MIGRATION_SSH_RELAY_SOURCE_KIND = 'ssh-relay' as const

/** Non-SSH kinds and the destination capability that proves a destination parses each one. */
export const KINGUD_MIGRATION_SOURCE_KIND_CAPABILITIES = {
  'local-wsl': KINGUD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
} as const

export type KingudMigrationNonSshSourceKind = keyof typeof KINGUD_MIGRATION_SOURCE_KIND_CAPABILITIES
export type KingudMigrationSourceKind =
  | typeof KINGUD_MIGRATION_SSH_RELAY_SOURCE_KIND
  | KingudMigrationNonSshSourceKind

export const KINGUD_MIGRATION_SOURCE_KIND_UNKNOWN = 'kingud_migration_source_kind_unknown'

/** A manifest source as it travels: this build may not know every field a newer peer signed. */
export type KingudMigrationWireSource = Readonly<Record<string, unknown>>

/** Reads the wire discriminator; a source without one is the relay-era SSH source. */
export function kingudMigrationManifestSourceKind(
  source: KingudMigrationWireSource
): KingudMigrationSourceKind {
  if (source.kind === undefined) {
    return KINGUD_MIGRATION_SSH_RELAY_SOURCE_KIND
  }
  // An explicit 'ssh-relay' is refused too: SSH has exactly one encoding, so one digest.
  if (isNonSshSourceKind(source.kind)) {
    return source.kind
  }
  throw new Error(KINGUD_MIGRATION_SOURCE_KIND_UNKNOWN)
}

function isNonSshSourceKind(kind: unknown): kind is KingudMigrationNonSshSourceKind {
  return typeof kind === 'string' && Object.hasOwn(KINGUD_MIGRATION_SOURCE_KIND_CAPABILITIES, kind)
}

/** The capability a destination must advertise before it may see this source; null for SSH. */
export function requiredKingudMigrationSourceCapability(
  source: KingudMigrationWireSource
): string | null {
  const kind = kingudMigrationManifestSourceKind(source)
  return kind === KINGUD_MIGRATION_SSH_RELAY_SOURCE_KIND
    ? null
    : KINGUD_MIGRATION_SOURCE_KIND_CAPABILITIES[kind]
}

export function isKingudMigrationLocalWslSource(
  source: KingudMigrationManifestSource
): source is KingudMigrationLocalWslManifestSource {
  return 'kind' in source && source.kind === 'local-wsl'
}

/** For the SSH conversion's own steps: a WSL manifest reaching them is a bug, never a fallback. */
export function requireKingudMigrationSshSource(
  source: KingudMigrationManifestSource
): KingudMigrationSshManifestSource {
  if (isKingudMigrationLocalWslSource(source)) {
    throw new Error('kingud_migration_source_not_ssh')
  }
  return source
}
