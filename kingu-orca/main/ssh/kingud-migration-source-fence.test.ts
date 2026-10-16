import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getManagedKingudFenceEnvironmentId } from '../../shared/managed-kingud-ssh-owner'
import type { SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import {
  listKingudMigrationSourceCutovers,
  kingudMigrationCutoverJournalDirectory
} from './kingud-migration-cutover-journal'
import {
  fenceKingudMigrationSource,
  resolveKingudMigrationFence
} from './kingud-migration-source-fence'
import type { KingudMigrationTerminalVerdict } from './kingud-migration-terminal-gate'
import { SshTargetKingudClaims } from './ssh-target-kingud-claims'

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 2
}
const exited: KingudMigrationTerminalVerdict = { verdict: 'exited', provenPtyIds: [] }

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function setup() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'kingud-migration-fence-'))
  directories.push(userDataPath)
  const dataFile = join(userDataPath, 'kingu-data.json')
  const store = createSqliteTestStore(Store, { dataFile })
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
  const claims = new SshTargetKingudClaims(store)
  const fence = (overrides: Partial<Parameters<typeof fenceKingudMigrationSource>[0]> = {}) =>
    fenceKingudMigrationSource({
      userDataPath,
      store,
      claims,
      targetId: TARGET.id,
      destinationEnvironmentId: 'env-1',
      destinationName: 'Managed',
      terminalProof: exited,
      ...overrides
    })
  const target = () => store.getSshTarget(TARGET.id)!
  return { userDataPath, dataFile, store, claims, fence, target }
}

describe('migration source fence', () => {
  it('journals, then fences, then flushes, all before returning', async () => {
    const harness = setup()
    const order: string[] = []
    const journalWrite = vi
      .spyOn(harness.claims, 'fenceForMigration')
      .mockImplementation((...args) => {
        order.push(
          listKingudMigrationSourceCutovers(harness.userDataPath).length ? 'journal' : 'none'
        )
        order.push('fence')
        return SshTargetKingudClaims.prototype.fenceForMigration.apply(harness.claims, args)
      })
    const flush = vi.spyOn(harness.claims, 'flush').mockImplementation(async () => {
      order.push(harness.target().kingudFence ? 'flush-after-fence' : 'flush-before-fence')
    })
    const result = await harness.fence()
    expect(result).toMatchObject({ outcome: 'fenced', resumed: false })
    expect(order).toEqual(['journal', 'fence', 'flush-after-fence'])
    expect(getManagedKingudFenceEnvironmentId(harness.target())).toBe('env-1')
    journalWrite.mockRestore()
    flush.mockRestore()
  })

  it('keeps the journal out of the profile, where an older build would strip it', async () => {
    const harness = setup()
    const result = await harness.fence()
    if (result.outcome !== 'fenced') {
      throw new Error('expected a fence')
    }
    await harness.store.flushPendingOrThrowAsync()
    const journalDirectory = kingudMigrationCutoverJournalDirectory(harness.userDataPath)
    const profileFiles = readdirSync(harness.userDataPath, { recursive: true, encoding: 'utf8' })
      .map((name) => join(harness.userDataPath, name))
      .filter((path) => !path.startsWith(journalDirectory) && statSync(path).isFile())
    expect(profileFiles.length).toBeGreaterThan(0)
    for (const path of profileFiles) {
      expect(readFileSync(path).includes(result.cutover.migrationId)).toBe(false)
    }
    const [onDisk] = listKingudMigrationSourceCutovers(harness.userDataPath)
    expect(onDisk).toMatchObject({ phase: 'source-fenced', sshTargetGeneration: 2 })
    expect(onDisk?.manifest.payload.repositories.map((repo) => repo.id)).toEqual(['repo-1'])
  })

  it('resumes the same migration instead of starting a second one', async () => {
    const harness = setup()
    const first = await harness.fence()
    const second = await harness.fence({
      terminalProof: { verdict: 'live', ptyIds: ['p'], reason: 'x' }
    })
    expect(second).toMatchObject({ outcome: 'fenced', resumed: true })
    expect(
      first.outcome === 'fenced' && second.outcome === 'fenced' && second.cutover.migrationId
    ).toBe(first.outcome === 'fenced' && first.cutover.migrationId)
    expect(listKingudMigrationSourceCutovers(harness.userDataPath)).toHaveLength(1)
  })

  it('treats a fence whose journal was lost as unverifiable and never releases it', async () => {
    const harness = setup()
    await harness.fence()
    rmSync(kingudMigrationCutoverJournalDirectory(harness.userDataPath), { recursive: true })
    expect(resolveKingudMigrationFence(harness.userDataPath, harness.target())).toEqual({
      state: 'fenced-unverifiable',
      environmentId: 'env-1'
    })
    await expect(harness.fence()).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'kingud_migration_fenced_unverifiable'
    })
    expect(getManagedKingudFenceEnvironmentId(harness.target())).toBe('env-1')
  })

  it('treats a journal whose fence an older build removed as stale, granting nothing', async () => {
    const harness = setup()
    await harness.fence()
    harness.store.updateSshTarget(TARGET.id, { kingudFence: undefined })
    expect(resolveKingudMigrationFence(harness.userDataPath, harness.target()).state).toBe(
      'stale-journal'
    )
    await expect(harness.fence()).resolves.toMatchObject({ code: 'kingud_migration_stale_journal' })
  })

  it('fails closed on an unreadable journal', async () => {
    const harness = setup()
    await harness.fence()
    const [cutover] = listKingudMigrationSourceCutovers(harness.userDataPath)
    writeFileSync(
      join(
        kingudMigrationCutoverJournalDirectory(harness.userDataPath),
        `${cutover!.migrationId}.json`
      ),
      '{not json'
    )
    expect(() => resolveKingudMigrationFence(harness.userDataPath, harness.target())).toThrow(
      'stays fenced'
    )
    await expect(harness.fence()).rejects.toThrow('stays fenced')
  })

  it.each<[KingudMigrationTerminalVerdict, string]>([
    [{ verdict: 'live', ptyIds: ['p'], reason: 'terminals run' }, 'live'],
    [{ verdict: 'unverifiable', ptyIds: ['p'], reason: 'relay silent' }, 'unverifiable']
  ])('refuses before fencing when terminals are %j', async (terminalProof, verdict) => {
    const harness = setup()
    await expect(harness.fence({ terminalProof })).resolves.toMatchObject({
      outcome: 'refused',
      verdict
    })
    expect(harness.target().kingudFence).toBeUndefined()
    expect(listKingudMigrationSourceCutovers(harness.userDataPath)).toEqual([])
  })

  it('keeps a blocker it could not read unverifiable, never live', async () => {
    const harness = setup()
    vi.spyOn(harness.store, 'inspectKingudMigrationUntransferredDependencies').mockImplementation(
      () => {
        throw new Error('census failed')
      }
    )
    await expect(harness.fence()).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'kingud_migration_preflight_blocked'
    })
  })

  it('releases its own fence when a terminal appeared before the fence took hold', async () => {
    const harness = setup()
    const flush = vi.spyOn(harness.claims, 'flush').mockImplementation(async () => {
      if (harness.target().kingudFence) {
        vi.spyOn(harness.store, 'getSshRemotePtyLeases').mockReturnValue([
          { targetId: TARGET.id, ptyId: 'late-pty', state: 'detached', createdAt: 1, updatedAt: 1 }
        ])
      }
    })
    await expect(harness.fence()).resolves.toMatchObject({ outcome: 'refused', verdict: 'live' })
    expect(harness.target().kingudFence).toBeUndefined()
    expect(listKingudMigrationSourceCutovers(harness.userDataPath)).toEqual([])
    flush.mockRestore()
  })
})
