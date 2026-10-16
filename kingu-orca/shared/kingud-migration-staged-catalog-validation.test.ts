import { describe, expect, it } from 'vitest'
import { normalizeKingudMigrationStagedCatalogs } from './kingud-migration-staged-catalog-validation'
import { KINGUD_MIGRATION_MANIFEST_VERSION } from './kingud-migration-manifest-validation'

function staged(migrationId: string) {
  return {
    version: KINGUD_MIGRATION_MANIFEST_VERSION,
    stagedAt: '2026-08-30T12:00:00.000Z',
    manifest: {
      version: KINGUD_MIGRATION_MANIFEST_VERSION,
      migrationId,
      createdAt: '2026-08-30T12:00:00.000Z',
      source: { sshTargetId: 'ssh-prod', sshTargetGeneration: 1, targetLabel: 'Production' },
      payload: { repositories: [], projectGroups: [], folderWorkspaces: [] },
      manifestSha256: 'a'.repeat(64)
    }
  }
}

describe('kingud staged catalog normalization', () => {
  it('recovers without Node 20-only array methods', () => {
    const prototype: object = Array.prototype
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'toReversed')
    try {
      Object.defineProperty(prototype, 'toReversed', {
        configurable: true,
        value: undefined,
        writable: true
      })
      expect(normalizeKingudMigrationStagedCatalogs([staged('migration-1')])).toEqual([
        expect.objectContaining({
          manifest: expect.objectContaining({ migrationId: 'migration-1' })
        })
      ])
    } finally {
      if (descriptor) {
        Object.defineProperty(prototype, 'toReversed', descriptor)
      } else {
        Reflect.deleteProperty(prototype, 'toReversed')
      }
    }
  })
})
