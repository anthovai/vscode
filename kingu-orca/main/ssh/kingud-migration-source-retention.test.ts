import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  listKingudMigrationSourceCutovers,
  writeKingudMigrationSourceCutover
} from './kingud-migration-cutover-journal'
import { kingudMigrationCutoverFixture } from './kingud-migration-cutover-fixture'
import { listPendingManagedKingudMigrations } from './kingud-managed-migration-status'
import { retainKingudMigrationSource } from './kingud-migration-source-retention'

let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'kingud-retention-'))
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('retaining a committed migration source', () => {
  it('marks only a committed cutover, idempotently, and stops counting it as pending', () => {
    writeKingudMigrationSourceCutover(userDataPath, kingudMigrationCutoverFixture('m-1'))
    expect(() => retainKingudMigrationSource(userDataPath, 'm-1')).toThrow(
      'kingud_migration_retain_before_commit'
    )
    const committed = {
      ...kingudMigrationCutoverFixture('m-1'),
      phase: 'destination-committed' as const
    }
    writeKingudMigrationSourceCutover(userDataPath, committed)
    const at = () => new Date('2026-10-03T00:00:00.000Z')
    retainKingudMigrationSource(userDataPath, 'm-1', at)
    retainKingudMigrationSource(userDataPath, 'm-1', () => new Date('2026-12-01T00:00:00.000Z'))
    expect(listKingudMigrationSourceCutovers(userDataPath)[0]?.sourceRetainedAt).toBe(
      '2026-10-03T00:00:00.000Z'
    )
    expect(listPendingManagedKingudMigrations(userDataPath)).toEqual([])
  })

  it('does not count retained cutovers against the in-flight journal capacity', () => {
    for (let index = 0; index < 4; index += 1) {
      const id = `m-${index}`
      writeKingudMigrationSourceCutover(userDataPath, {
        ...kingudMigrationCutoverFixture(id, `ssh-${index}`),
        phase: 'destination-committed',
        sourceRetainedAt: '2026-10-03T00:00:00.000Z'
      })
    }
    expect(() =>
      writeKingudMigrationSourceCutover(
        userDataPath,
        kingudMigrationCutoverFixture('m-new', 'ssh-9')
      )
    ).not.toThrow()
  })
})
