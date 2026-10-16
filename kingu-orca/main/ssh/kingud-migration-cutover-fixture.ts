import { KINGUD_MIGRATION_MANIFEST_VERSION } from '../../shared/kingud-migration-manifest'
import type { KingudMigrationSourceCutover } from '../../shared/kingud-migration-source-cutover'
import { computeKingudMigrationManifestSha256 } from '../kingud/kingud-migration-manifest-digest'

/** A valid journal entry whose manifest is bound to its target, generation and destination. */
export function kingudMigrationCutoverFixture(
  migrationId = 'migration-1',
  sshTargetId = 'ssh-1',
  binding: { generation?: number; environmentId?: string; name?: string } = {}
): KingudMigrationSourceCutover {
  const generation = binding.generation ?? 2
  const environmentId = binding.environmentId ?? 'env-1'
  const unsigned = {
    version: KINGUD_MIGRATION_MANIFEST_VERSION,
    migrationId,
    createdAt: '2026-10-01T00:00:00.000Z',
    source: { sshTargetId, sshTargetGeneration: generation, targetLabel: 'Prod' },
    payload: { repositories: [], projectGroups: [], folderWorkspaces: [] },
    destinationEnvironmentId: environmentId
  }
  const manifest = { ...unsigned, manifestSha256: computeKingudMigrationManifestSha256(unsigned) }
  return {
    version: 1,
    migrationId,
    phase: 'source-fenced',
    startedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    destinationEnvironmentId: environmentId,
    destinationName: binding.name ?? 'Managed',
    sshTargetId,
    sshTargetGeneration: generation,
    manifestSha256: manifest.manifestSha256,
    provenPtyIds: [],
    manifest
  }
}
