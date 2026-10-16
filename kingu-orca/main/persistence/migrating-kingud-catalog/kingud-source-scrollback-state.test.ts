import { describe, expect, it } from 'vitest'
import type { KingudMigrationTerminalScrollbackSnapshot } from '../../../shared/kingud-migration-scrollback'
import { hasDuplicateKingudMigrationScrollbackDescriptors } from './kingud-source-scrollback-state'

const FIRST: KingudMigrationTerminalScrollbackSnapshot = {
  tabId: 'tab-1',
  leafId: 'leaf-1',
  ref: `v1-${'1'.repeat(32)}`,
  sha256: 'a'.repeat(64),
  byteLength: 1
}

describe('kingud source scrollback projection', () => {
  it('refuses duplicate refs or tab/leaf identities across merged fragments', () => {
    expect(
      hasDuplicateKingudMigrationScrollbackDescriptors([
        FIRST,
        { ...FIRST, tabId: 'tab-2', leafId: 'leaf-2' }
      ])
    ).toBe(true)
    expect(
      hasDuplicateKingudMigrationScrollbackDescriptors([
        FIRST,
        { ...FIRST, ref: `v1-${'2'.repeat(32)}` }
      ])
    ).toBe(true)
    expect(
      hasDuplicateKingudMigrationScrollbackDescriptors([
        FIRST,
        {
          ...FIRST,
          tabId: 'tab-2',
          leafId: 'leaf-2',
          ref: `v1-${'2'.repeat(32)}`
        }
      ])
    ).toBe(false)
  })
})
