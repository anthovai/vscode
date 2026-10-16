import { describe, expect, it } from 'vitest'
import {
  KINGUD_MIGRATION_MANIFEST_VERSION,
  parseKingudMigrationManifest
} from './kingud-migration-manifest'

const digest = 'a'.repeat(64)

function manifest(overrides: { version?: unknown; dormantState?: unknown } = {}) {
  return {
    version: overrides.version ?? KINGUD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-contract',
    createdAt: '2026-10-01T12:00:00.000Z',
    source: { sshTargetId: 'target', sshTargetGeneration: 3, targetLabel: 'Host' },
    payload: {
      repositories: [
        {
          id: 'repo-1',
          path: '/srv/repo-1',
          displayName: 'Repo',
          badgeColor: '#737373',
          addedAt: 1
        }
      ],
      projectGroups: [
        {
          id: 'group-1',
          name: 'Folders',
          tabOrder: 0,
          createdAt: 1,
          updatedAt: 1,
          parentPath: null,
          parentGroupId: null,
          isCollapsed: false,
          color: null,
          createdFrom: 'manual'
        }
      ],
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          name: 'Notes',
          folderPath: '/srv/notes',
          sortOrder: 0,
          lastActivityAt: 1,
          createdAt: 1,
          updatedAt: 1,
          isArchived: false,
          isUnread: false,
          isPinned: false
        }
      ],
      ...(overrides.dormantState === undefined ? {} : { dormantState: overrides.dormantState })
    },
    manifestSha256: digest
  }
}

function dormantLineage(childWorkspaceKey: string, parentWorkspaceKey: string) {
  const lineage = {
    childWorkspaceKey,
    parentWorkspaceKey,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
  return {
    version: 1,
    worktreeMeta: [],
    worktreeLineage: [],
    workspaceLineage: [{ sourceKey: childWorkspaceKey, childWorkspaceKey, lineage }],
    sparsePresets: [],
    retiredWorktreeNames: [],
    retiredWorktreeNamespaces: []
  }
}

describe('kingud migration manifest contract', () => {
  it('is an explicit version 1 artifact', () => {
    expect(KINGUD_MIGRATION_MANIFEST_VERSION).toBe(1)
    expect(parseKingudMigrationManifest(manifest()).version).toBe(1)
  })

  it.each([2, 10, 0, '1', undefined, null])(
    'rejects manifest version %j instead of guessing its shape',
    (version) => {
      expect(() => parseKingudMigrationManifest({ ...manifest(), version })).toThrow(
        'kingud_migration_manifest_version_unsupported'
      )
    }
  )

  it('validates folder workspace keys alongside worktree workspace keys', () => {
    const parsed = parseKingudMigrationManifest(
      manifest({ dormantState: dormantLineage('folder:folder-1', 'worktree:repo-1::/srv/repo-1') })
    )
    expect(parsed.payload.dormantState?.workspaceLineage[0]?.lineage).toMatchObject({
      childWorkspaceKey: 'folder:folder-1',
      parentWorkspaceKey: 'worktree:repo-1::/srv/repo-1',
      childInstanceId: null,
      parentInstanceId: null
    })
  })

  it.each([
    ['a folder workspace outside the catalog', 'folder:folder-2'],
    ['a worktree outside the catalog', 'worktree:repo-2::/srv/repo-2']
  ])('refuses lineage that names %s', (_label, key) => {
    expect(() =>
      parseKingudMigrationManifest(
        manifest({ dormantState: dormantLineage(key, 'folder:folder-1') })
      )
    ).toThrow('kingud_migration_dormant_workspace_lineage_scope_invalid')
  })

  it('rejects a malformed workspace key rather than treating it as a worktree id', () => {
    expect(() =>
      parseKingudMigrationManifest(
        manifest({ dormantState: dormantLineage('folder:', 'folder:folder-1') })
      )
    ).toThrow('kingud_migration_dormant_lineage_workspace_key_invalid')
  })
})
