import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { MAX_KINGUD_MIGRATION_IMPORT_RECEIPTS } from '../../../shared/kingud-migration-manifest'
import { manifest } from '../../persistence-kingud-migration-catalog-fixture'
import {
  expireKingudMigrationStages,
  findKingudMigrationImportReceipt,
  KINGUD_MIGRATION_STAGE_TTL_MS,
  recordKingudMigrationImportReceipt
} from './kingud-catalog-receipt-ledger'

const empty = { repositories: [], projectGroups: [], folderWorkspaces: [] }

function receiptFor(migrationId: string) {
  const input = manifest({ migrationId, payload: empty })
  return {
    input,
    receipt: {
      version: input.version,
      migrationId,
      manifestSha256: input.manifestSha256,
      source: input.source,
      importedAt: '2026-10-01T00:00:00.000Z',
      repositoryIds: [],
      projectGroupIds: [],
      folderWorkspaceIds: []
    }
  }
}

describe('kingud migration receipt ledger', () => {
  it('keeps answering for a commit whose receipt aged out of the bounded list', () => {
    const state = getDefaultPersistedState('/tmp/kingud-receipt-ledger')
    const first = receiptFor('migration-0')
    recordKingudMigrationImportReceipt(state, first.receipt)
    for (let index = 1; index <= MAX_KINGUD_MIGRATION_IMPORT_RECEIPTS; index++) {
      recordKingudMigrationImportReceipt(state, receiptFor(`migration-${index}`).receipt)
    }
    expect(state.kingudMigrationImportReceipts).toHaveLength(MAX_KINGUD_MIGRATION_IMPORT_RECEIPTS)
    expect(findKingudMigrationImportReceipt(state, first.input)).toEqual(first.receipt)
    expect(findKingudMigrationImportReceipt(state, receiptFor('never').input)).toBeUndefined()
  })

  it('expires a stage no client came back for', () => {
    const state = getDefaultPersistedState('/tmp/kingud-receipt-ledger')
    const stagedAt = '2026-10-01T00:00:00.000Z'
    state.kingudMigrationStagedCatalogs = [{ version: 1, manifest: manifest(), stagedAt }]
    const start = Date.parse(stagedAt)
    expect(expireKingudMigrationStages(state, start + KINGUD_MIGRATION_STAGE_TTL_MS - 1)).toBe(
      false
    )
    expect(expireKingudMigrationStages(state, start + KINGUD_MIGRATION_STAGE_TTL_MS)).toBe(true)
    expect(state.kingudMigrationStagedCatalogs).toEqual([])
  })
})
