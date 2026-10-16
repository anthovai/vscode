import { z } from 'zod'
import {
  MAX_KINGUD_MIGRATION_BLOBS,
  KingudMigrationBlobDescriptorSchema
} from '../kingud-migration-blob-transfer'

// Why unknown: the handler parses and digest-checks the manifest itself, so a malformed one is
// refused with a migration error rather than a generic params failure.
export const KingudMigrationCatalogParams = z.object({ manifest: z.unknown() })

// Optional: sent only to a blob-channel destination, so SSH and older peers see `{ manifest }`.
export const KingudMigrationCommitCatalogParams = KingudMigrationCatalogParams.extend({
  expectedBlobs: z
    .array(KingudMigrationBlobDescriptorSchema)
    .max(MAX_KINGUD_MIGRATION_BLOBS)
    .optional()
})
