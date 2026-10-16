import type { KingudMigrationCatalogState } from '../../shared/kingud-migration-manifest'

export async function resolveDurableKingudCatalogMutation(
  mutate: () => Promise<KingudMigrationCatalogState>,
  read: () => Promise<KingudMigrationCatalogState>,
  accepted: (state: KingudMigrationCatalogState) => boolean
) {
  try {
    return await mutate()
  } catch (mutationError) {
    let observed: KingudMigrationCatalogState
    try {
      observed = await read()
    } catch {
      throw mutationError
    }
    if (!accepted(observed)) {
      throw mutationError
    }
  }
  // State reads may reflect unflushed mutations; an idempotent acknowledgment proves durability.
  return mutate()
}
