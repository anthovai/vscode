import { createHash } from 'node:crypto'
import {
  kingudMigrationManifestHashInput,
  serializeKingudMigrationValue,
  type KingudMigrationManifest
} from '../../shared/kingud-migration-manifest'

export function computeKingudMigrationManifestSha256(
  manifest: Omit<KingudMigrationManifest, 'manifestSha256'>
): string {
  return createHash('sha256').update(kingudMigrationManifestHashInput(manifest)).digest('hex')
}

/** Pass the manifest as received: a newer peer's unknown fields are part of what it signed. */
export function assertKingudMigrationManifestDigest(manifest: unknown): void {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('kingud_migration_manifest_invalid')
  }
  const unsigned = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'manifestSha256')
  )
  const digest = createHash('sha256').update(serializeKingudMigrationValue(unsigned)).digest('hex')
  if (!('manifestSha256' in manifest) || digest !== manifest.manifestSha256) {
    throw new Error('kingud_migration_manifest_digest_mismatch')
  }
}
