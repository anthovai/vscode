import { describe, expect, it } from 'vitest'
import type { KingudMigrationManifestSource } from '../../shared/kingud-migration-manifest'
import {
  assertKingudMigrationSourceServedHere,
  KINGUD_MIGRATION_SOURCE_NOT_THIS_HOST,
  servesLocalWslMigrationSource
} from './kingud-migration-wsl-destination'

const WSL_SOURCE: KingudMigrationManifestSource = {
  kind: 'local-wsl',
  distro: 'Ubuntu',
  scopeRepoIds: ['repo-1'],
  scopeFolderWorkspaceIds: [],
  generation: 1
}
const SSH_SOURCE: KingudMigrationManifestSource = {
  sshTargetId: 'ssh-1',
  sshTargetGeneration: 1,
  targetLabel: 'Prod'
}
const WSL_HOST = { KINGU_WSL_KINGUD_HOST: '1', WSL_DISTRO_NAME: 'ubuntu' }

describe('WSL migration destination', () => {
  it('serves the WSL source only on the kingud Kingu launched inside a distro', () => {
    expect(servesLocalWslMigrationSource(WSL_HOST, 'linux')).toBe(true)
    // An SSH remote or Kingu under WSLg is a WSL guest too, but not a WSL host's kingud.
    expect(servesLocalWslMigrationSource({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux')).toBe(false)
    expect(servesLocalWslMigrationSource(WSL_HOST, 'win32')).toBe(false)
  })

  it('accepts its own distro, case-insensitively', () => {
    expect(() => assertKingudMigrationSourceServedHere(WSL_SOURCE, WSL_HOST, 'linux')).not.toThrow()
  })

  it.each([
    ['another distro', { ...WSL_HOST, WSL_DISTRO_NAME: 'Debian' }, 'linux'],
    ['a plain Linux host', {}, 'linux'],
    ['a desktop', WSL_HOST, 'darwin']
  ] as const)('refuses a WSL source on %s', (_label, env, platform) => {
    expect(() => assertKingudMigrationSourceServedHere(WSL_SOURCE, env, platform)).toThrow(
      KINGUD_MIGRATION_SOURCE_NOT_THIS_HOST
    )
  })

  it('refuses a source from another registration of the same distro name', () => {
    const source = { ...WSL_SOURCE, distroGuid: '{AAAA}' }
    expect(() =>
      assertKingudMigrationSourceServedHere(
        source,
        { ...WSL_HOST, KINGU_WSL_DISTRO_GUID: '{aaaa}' },
        'linux'
      )
    ).not.toThrow()
    for (const env of [{ ...WSL_HOST, KINGU_WSL_DISTRO_GUID: '{BBBB}' }, WSL_HOST]) {
      expect(() => assertKingudMigrationSourceServedHere(source, env, 'linux')).toThrow(
        KINGUD_MIGRATION_SOURCE_NOT_THIS_HOST
      )
    }
  })

  it('leaves the SSH conversion alone everywhere', () => {
    expect(() => assertKingudMigrationSourceServedHere(SSH_SOURCE, {}, 'linux')).not.toThrow()
  })
})
