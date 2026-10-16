import { describe, expect, it, vi } from 'vitest'
import { KinguRuntimeService } from './kingu-runtime-test-mocks.spec'
import { store } from './kingu-runtime-test-fixtures.spec'
import {
  KINGUD_MIGRATION_MANIFEST_VERSION,
  type KingudMigrationCatalogState,
  type KingudMigrationManifest
} from '../../shared/kingud-migration-manifest'

const manifest: KingudMigrationManifest = {
  version: KINGUD_MIGRATION_MANIFEST_VERSION,
  migrationId: 'migration-capabilities',
  createdAt: '2026-08-30T12:00:00.000Z',
  source: { sshTargetId: 'source', sshTargetGeneration: null, targetLabel: 'Source' },
  payload: { repositories: [], projectGroups: [], folderWorkspaces: [] },
  manifestSha256: '0'.repeat(64)
}

const staged: KingudMigrationCatalogState = {
  state: 'staged',
  migrationId: manifest.migrationId,
  manifestSha256: manifest.manifestSha256,
  stagedAt: manifest.createdAt
}

describe('runtime migration catalog capabilities', () => {
  it('refuses a catalog read when the runtime has no store', () => {
    const runtime = new KinguRuntimeService(null)
    expect(() => runtime.getKingudMigrationCatalogState(manifest)).toThrow('runtime_unavailable')
  })

  it('refuses a missing catalog reader on a partial store', () => {
    const runtime = new KinguRuntimeService(store)
    expect(() => runtime.getKingudMigrationCatalogState(manifest)).toThrow('runtime_unavailable')
  })

  it('refuses staging before mutation when the partial store cannot flush', async () => {
    const stage = vi.fn(() => staged)
    const runtime = new KinguRuntimeService({ ...store, stageKingudMigrationCatalog: stage })
    await expect(runtime.stageKingudMigrationCatalog(manifest)).rejects.toThrow(
      'runtime_unavailable'
    )
    expect(stage).not.toHaveBeenCalled()
  })

  it('admits staging with only the methods that operation needs', async () => {
    const stage = vi.fn(() => staged)
    const flush = vi.fn(async () => {})
    const runtime = new KinguRuntimeService({
      ...store,
      stageKingudMigrationCatalog: stage,
      flushPendingOrThrowAsync: flush
    })
    await expect(runtime.stageKingudMigrationCatalog(manifest)).resolves.toBe(staged)
    expect(stage).toHaveBeenCalledWith(manifest)
    expect(flush).toHaveBeenCalledOnce()
  })
})
