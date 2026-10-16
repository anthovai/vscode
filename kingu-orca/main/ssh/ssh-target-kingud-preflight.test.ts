import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SshRemotePtyLease, SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import {
  preflightKingudMigrationExport,
  type KingudMigrationPreflightStore
} from './ssh-target-kingud-preflight'

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 2
}

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function preflightStore(
  configure: (store: Store) => void,
  overrides: Partial<KingudMigrationPreflightStore> = {}
): KingudMigrationPreflightStore {
  const directory = mkdtempSync(join(tmpdir(), 'kingud-export-preflight-'))
  directories.push(directory)
  const store = createSqliteTestStore(Store, { dataFile: join(directory, 'kingu-data.json') })
  configure(store)
  return {
    getSshTarget: (id) => store.getSshTarget(id),
    getSshRemotePtyLeases: (id) => store.getSshRemotePtyLeases(id),
    getRepos: () => store.getRepos(),
    getFolderWorkspaces: () => store.getFolderWorkspaces(),
    getProjectGroups: () => store.getProjectGroups(),
    collectKingudMigrationSourceDormantState: (...args) =>
      store.collectKingudMigrationSourceDormantState(...args),
    inspectKingudMigrationUntransferredDependencies: (manifest) =>
      store.inspectKingudMigrationUntransferredDependencies(manifest),
    ...overrides
  }
}

function withRepo(store: Store): void {
  store.addSshTarget(TARGET)
  store.addRepo({
    id: 'repo-1',
    path: '/srv/app',
    displayName: 'App',
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId: TARGET.id
  })
}

describe('migration export preflight', () => {
  it('drains the catalog the target owns instead of blocking on it', () => {
    const result = preflightKingudMigrationExport(preflightStore(withRepo), TARGET.id)
    expect(result.claimable).toBe(true)
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      'kingud_migration_direct_ssh_repositories'
    ])
  })

  it('previews a connected but unused host as movable with no blockers', () => {
    const store = preflightStore((store) => {
      store.addSshTarget(TARGET)
      // What the renderer writes on connect: the reconnect hint names the now-connected target.
      store.patchWorkspaceSession({ activeConnectionIdsAtShutdown: [TARGET.id] })
    })
    expect(preflightKingudMigrationExport(store, TARGET.id)).toMatchObject({
      claimable: true,
      blockers: []
    })
  })

  it('blocks on a live relay terminal, which cannot move', () => {
    const lease: SshRemotePtyLease = {
      targetId: TARGET.id,
      ptyId: 'pty-1',
      state: 'attached',
      createdAt: 1,
      updatedAt: 1
    }
    const result = preflightKingudMigrationExport(
      preflightStore(withRepo, { getSshRemotePtyLeases: () => [lease] }),
      TARGET.id
    )
    expect(result.claimable).toBe(false)
    expect(result.blockers.map((blocker) => blocker.code)).toContain(
      'kingud_migration_direct_ssh_terminal_leases'
    )
  })

  it('blocks on dependent state the manifest cannot carry', () => {
    const result = preflightKingudMigrationExport(
      preflightStore(withRepo, {
        inspectKingudMigrationUntransferredDependencies: () => ({
          totalCount: 2,
          counts: {
            automation: 2,
            'automation-run': 0,
            'mobile-tab-selection': 0,
            'retired-worktree-name': 0,
            'saved-port-forward': 0,
            'sparse-preset': 0,
            'terminal-lease': 0,
            'terminal-recovery': 0,
            'ui-routing': 0,
            'workspace-lineage': 0,
            'workspace-session': 0,
            'worktree-lineage': 0,
            'worktree-metadata': 0
          }
        })
      }),
      TARGET.id
    )
    expect(result.claimable).toBe(false)
    expect(result.blockers).toContainEqual({
      code: 'kingud_migration_dependent_state',
      category: 'client-owned-state',
      dependencies: [{ kind: 'automation', count: 2 }]
    })
  })

  it('treats a census the store could not take as unverifiable, never empty', () => {
    const result = preflightKingudMigrationExport(
      preflightStore(withRepo, {
        inspectKingudMigrationUntransferredDependencies: () => {
          throw new Error('state unreadable')
        }
      }),
      TARGET.id
    )
    expect(result.claimable).toBe(false)
    expect(result.blockers.map((blocker) => blocker.code)).toContain(
      'kingud_migration_dependency_unverifiable'
    )
  })

  it('refuses a target another runtime owns, and passes the owner only with its journal', () => {
    const owned = preflightStore((store) =>
      store.addSshTarget({ ...TARGET, kingudFence: { environmentId: 'env-1' } })
    )
    expect(preflightKingudMigrationExport(owned, TARGET.id).claimable).toBe(false)
    expect(
      preflightKingudMigrationExport(owned, TARGET.id, { environmentId: 'env-1', recorded: true })
        .claimable
    ).toBe(true)
    expect(
      preflightKingudMigrationExport(owned, TARGET.id, { environmentId: 'env-1', recorded: false })
    ).toMatchObject({
      claimable: false,
      blockers: [{ code: 'kingud_migration_owner_unrecorded' }]
    })
  })

  it('reports an unknown target', () => {
    expect(
      preflightKingudMigrationExport(
        preflightStore(() => {}),
        'missing'
      )
    ).toMatchObject({
      claimable: false,
      blockers: [{ code: 'kingud_migration_target_not_found' }]
    })
  })
})
