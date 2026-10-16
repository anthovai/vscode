import { describe, expect, it } from 'vitest'
import { isRecord } from './kingud-migration-manifest-fields'
import {
  KINGUD_MIGRATION_MANIFEST_VERSION,
  normalizeKingudMigrationImportReceipts,
  parseKingudMigrationManifest
} from './kingud-migration-manifest'
import {
  KINGUD_MIGRATION_SOURCE_KIND_UNKNOWN,
  kingudMigrationManifestSourceKind,
  requiredKingudMigrationSourceCapability
} from './kingud-migration-source-kind'
import {
  KINGUD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY,
  KINGUD_RUNTIME_CAPABILITIES
} from './kingud-runtime-capabilities'

const SSH_SOURCE = { sshTargetId: 'ssh-1', sshTargetGeneration: 2, targetLabel: 'Prod' }
const WSL_SOURCE = {
  kind: 'local-wsl',
  distro: 'Ubuntu',
  scopeRepoIds: ['repo-1'],
  scopeFolderWorkspaceIds: [],
  generation: 1
}
const WSL_REPO = {
  id: 'repo-1',
  path: '/home/dev/app',
  displayName: 'app',
  badgeColor: '#000',
  addedAt: 0
}

/** Exactly what a desktop that predates `source.kind` sends. */
function manifestWithSource(source: unknown) {
  return {
    version: KINGUD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-kind',
    createdAt: '2026-10-01T00:00:00.000Z',
    source,
    payload: {
      repositories: isRecord(source) && source.kind === 'local-wsl' ? [WSL_REPO] : [],
      projectGroups: [],
      folderWorkspaces: []
    },
    manifestSha256: 'a'.repeat(64)
  }
}

describe('kingud migration source kind', () => {
  it('reads an absent kind as the relay-era SSH source, which needs no extra capability', () => {
    expect(kingudMigrationManifestSourceKind(SSH_SOURCE)).toBe('ssh-relay')
    expect(kingudMigrationManifestSourceKind({ ...SSH_SOURCE, kind: undefined })).toBe('ssh-relay')
    expect(requiredKingudMigrationSourceCapability(SSH_SOURCE)).toBeNull()
  })

  it('gates a WSL source on its own capability, which only a WSL host advertises', () => {
    expect(requiredKingudMigrationSourceCapability({ kind: 'local-wsl' })).toBe(
      KINGUD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
    )
    expect(KINGUD_RUNTIME_CAPABILITIES).not.toContain(
      KINGUD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
    )
  })

  it.each(['ssh-relay', 'toString', 'wsl', 7, null])('refuses unregistered kind %j', (kind) => {
    expect(() => kingudMigrationManifestSourceKind({ kind })).toThrow(
      KINGUD_MIGRATION_SOURCE_KIND_UNKNOWN
    )
  })
})

describe('kingud migration manifest source on the destination', () => {
  it('accepts an older desktop manifest and its receipt unchanged', () => {
    expect(parseKingudMigrationManifest(manifestWithSource(SSH_SOURCE)).source).toEqual(SSH_SOURCE)
    const receipt = {
      version: KINGUD_MIGRATION_MANIFEST_VERSION,
      migrationId: 'migration-kind',
      manifestSha256: 'a'.repeat(64),
      source: SSH_SOURCE,
      importedAt: '2026-10-01T00:00:00.000Z',
      repositoryIds: [],
      projectGroupIds: [],
      folderWorkspaceIds: []
    }
    expect(normalizeKingudMigrationImportReceipts([receipt])).toEqual([receipt])
  })

  it('refuses an explicit SSH kind, and a WSL source carrying SSH fields', () => {
    expect(() =>
      parseKingudMigrationManifest(manifestWithSource({ ...SSH_SOURCE, kind: 'ssh-relay' }))
    ).toThrow('kingud_migration_manifest_source_kind_unsupported')
    expect(() =>
      parseKingudMigrationManifest(manifestWithSource({ ...WSL_SOURCE, sshTargetId: 'ssh-1' }))
    ).toThrow('kingud_migration_manifest_source_invalid')
  })

  it('parses a WSL source whose scope is exactly the catalog it moves', () => {
    const manifest = parseKingudMigrationManifest(
      manifestWithSource({ ...WSL_SOURCE, distroGuid: '{guid}' })
    )
    expect(manifest.source).toEqual({ ...WSL_SOURCE, distroGuid: '{guid}' })
  })

  it.each([
    { scopeRepoIds: ['repo-other'] },
    { scopeRepoIds: [] },
    { scopeFolderWorkspaceIds: ['folder-1'] },
    { generation: 0 },
    { distro: '' }
  ])('refuses a WSL source that does not describe its catalog: %j', (override) => {
    expect(() =>
      parseKingudMigrationManifest(manifestWithSource({ ...WSL_SOURCE, ...override }))
    ).toThrow(/source/)
  })

  it('fails a WSL source closed on a destination that drops the kind', () => {
    // Without the SSH fields, even a parser that ignores `kind` cannot read it as an SSH source.
    const { kind: _kind, ...asOlderDestinationSeesIt } = {
      kind: 'local-wsl',
      distro: 'Ubuntu',
      targetLabel: 'Ubuntu'
    }
    expect(() =>
      parseKingudMigrationManifest(manifestWithSource(asOlderDestinationSeesIt))
    ).toThrow(/^kingud_migration_manifest_source/)
  })
})
