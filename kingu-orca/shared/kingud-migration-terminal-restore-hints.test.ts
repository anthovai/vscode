import { describe, expect, it } from 'vitest'
import {
  MAX_KINGUD_MIGRATION_TERMINAL_RESTORE_HINTS,
  MAX_KINGUD_MIGRATION_TERMINAL_RESTORE_HINTS_BYTES,
  parseKingudMigrationTerminalRestoreHintsDocument,
  parseKingudMigrationTerminalRestoreHintsText
} from './kingud-migration-terminal-restore-hints'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function document(hints: unknown[]): unknown {
  return { version: 1, hints }
}

describe('terminal restore hints document', () => {
  it('accepts stable pane keys with absolute POSIX folders and drops unknown fields', () => {
    expect(
      parseKingudMigrationTerminalRestoreHintsDocument({
        version: 1,
        hints: [{ paneKey: PANE_KEY, cwd: '/home/me/src', extra: true }],
        futureField: 1
      })
    ).toEqual({ version: 1, hints: [{ paneKey: PANE_KEY, cwd: '/home/me/src' }] })
  })

  it.each([
    ['a legacy numeric pane id', 'tab-1:3'],
    ['a key without a tab', ':11111111-1111-4111-8111-111111111111'],
    ['a key with two separators', 'a:b:11111111-1111-4111-8111-111111111111'],
    ['an over-long key', `${'t'.repeat(200)}:11111111-1111-4111-8111-111111111111`]
  ])('refuses %s', (_label, paneKey) => {
    expect(() =>
      parseKingudMigrationTerminalRestoreHintsDocument(document([{ paneKey, cwd: '/home' }]))
    ).toThrow('kingud_migration_terminal_restore_hint_pane_key_invalid')
  })

  it.each([
    ['a relative folder', 'src/app'],
    ['a UNC-style folder', '//wsl.localhost/Ubuntu/home'],
    ['a Windows folder', 'C:\\Users\\me'],
    ['a folder with NUL', '/home/\0me'],
    ['an over-long folder', `/${'a'.repeat(4096)}`]
  ])('refuses %s', (_label, cwd) => {
    expect(() =>
      parseKingudMigrationTerminalRestoreHintsDocument(document([{ paneKey: PANE_KEY, cwd }]))
    ).toThrow('kingud_migration_terminal_restore_hint_cwd_invalid')
  })

  it('refuses duplicate panes, too many hints, other versions and non-JSON', () => {
    const hint = { paneKey: PANE_KEY, cwd: '/home' }
    expect(() => parseKingudMigrationTerminalRestoreHintsDocument(document([hint, hint]))).toThrow(
      'kingud_migration_terminal_restore_hint_duplicate'
    )
    expect(() =>
      parseKingudMigrationTerminalRestoreHintsDocument(
        document(
          Array.from({ length: MAX_KINGUD_MIGRATION_TERMINAL_RESTORE_HINTS + 1 }, () => hint)
        )
      )
    ).toThrow('kingud_migration_terminal_restore_hints_invalid')
    expect(() =>
      parseKingudMigrationTerminalRestoreHintsDocument({ version: 2, hints: [] })
    ).toThrow('kingud_migration_terminal_restore_hints_invalid')
    expect(() => parseKingudMigrationTerminalRestoreHintsText('{')).toThrow(
      'kingud_migration_terminal_restore_hints_not_json'
    )
  })

  it('refuses text over the blob cap before parsing it', () => {
    expect(() =>
      parseKingudMigrationTerminalRestoreHintsText(
        ' '.repeat(MAX_KINGUD_MIGRATION_TERMINAL_RESTORE_HINTS_BYTES + 1)
      )
    ).toThrow('kingud_migration_terminal_restore_hints_too_large')
  })
})
