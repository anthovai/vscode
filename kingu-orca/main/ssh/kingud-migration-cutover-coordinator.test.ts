import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getManagedKingudFenceEnvironmentId } from '../../shared/managed-kingud-ssh-owner'
import type { SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import {
  abortKingudMigrationCutover,
  commitKingudMigrationDestination,
  stageKingudMigrationDestination,
  type KingudMigrationCutoverContext
} from './kingud-migration-cutover-coordinator'
import { KINGUD_MIGRATION_DESTINATION_UNSUPPORTED } from './kingud-migration-catalog-client'
import { listKingudMigrationSourceCutovers } from './kingud-migration-cutover-journal'
import { fenceKingudMigrationSource } from './kingud-migration-source-fence'
import { SshTargetKingudClaims } from './ssh-target-kingud-claims'
import { fakeKingudMigrationDestination as fakeDestination } from './kingud-migration-destination-fake'

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

async function setup() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'kingud-cutover-coordinator-'))
  directories.push(userDataPath)
  const store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'kingu-data.json') })
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
  const fenced = await fenceKingudMigrationSource({
    userDataPath,
    store,
    claims,
    targetId: TARGET.id,
    destinationEnvironmentId: 'env-1',
    destinationName: 'Managed',
    terminalProof: { verdict: 'exited', provenPtyIds: [] }
  })
  if (fenced.outcome !== 'fenced') {
    throw new Error('expected a fence')
  }
  const destination = fakeDestination()
  const context: KingudMigrationCutoverContext = { userDataPath, store, claims, destination }
  const journal = () => listKingudMigrationSourceCutovers(userDataPath)[0]
  const owner = () => getManagedKingudFenceEnvironmentId(store.getSshTarget(TARGET.id))
  return { context, destination, store, migrationId: fenced.cutover.migrationId, journal, owner }
}

describe('migration cutover coordinator', () => {
  it('stages then commits once, journaling each phase the destination proves', async () => {
    const h = await setup()
    await expect(stageKingudMigrationDestination(h.context, h.migrationId)).resolves.toMatchObject({
      phase: 'destination-staged'
    })
    expect(h.journal()?.phase).toBe('destination-staged')
    await expect(commitKingudMigrationDestination(h.context, h.migrationId)).resolves.toMatchObject(
      {
        phase: 'destination-committed'
      }
    )
    expect(h.journal()?.phase).toBe('destination-committed')
    await commitKingudMigrationDestination(h.context, h.migrationId)
    expect(h.destination.commits).toBe(1)
  })

  it('reads a lost commit reply back from the destination instead of failing or retrying blind', async () => {
    const h = await setup()
    await stageKingudMigrationDestination(h.context, h.migrationId)
    const commit = h.destination.commit.getMockImplementation()!
    h.destination.commit.mockImplementationOnce(async (manifest) => {
      await commit(manifest)
      throw new Error('socket closed')
    })
    await expect(commitKingudMigrationDestination(h.context, h.migrationId)).resolves.toMatchObject(
      {
        phase: 'destination-committed'
      }
    )
    expect(h.destination.commits).toBe(1)
  })

  it('never journals a commit the server holds only in memory, until its flush succeeds', async () => {
    const h = await setup()
    await stageKingudMigrationDestination(h.context, h.migrationId)
    const commit = h.destination.commit.getMockImplementation()!
    let diskFull = true
    // The receipt lands in memory, so reads say committed, but the flush keeps failing.
    h.destination.commit.mockImplementation(async (manifest) => {
      const state = await commit(manifest)
      if (diskFull) {
        throw new Error('disk full')
      }
      return state
    })
    await expect(commitKingudMigrationDestination(h.context, h.migrationId)).rejects.toThrow(
      'disk full'
    )
    await expect(commitKingudMigrationDestination(h.context, h.migrationId)).rejects.toThrow(
      'disk full'
    )
    await expect(abortKingudMigrationCutover(h.context, h.migrationId)).rejects.toThrow('disk full')
    expect(h.journal()?.phase).toBe('destination-staged')
    expect(h.owner()).toBe('env-1')

    diskFull = false
    await expect(commitKingudMigrationDestination(h.context, h.migrationId)).resolves.toMatchObject(
      {
        phase: 'destination-committed'
      }
    )
  })

  it('keeps the journal at staged when the commit reply and the re-read are both lost', async () => {
    const h = await setup()
    await stageKingudMigrationDestination(h.context, h.migrationId)
    h.destination.commit.mockRejectedValueOnce(new Error('socket closed'))
    h.destination.readState.mockRejectedValueOnce(new Error('socket closed'))
    await expect(commitKingudMigrationDestination(h.context, h.migrationId)).rejects.toThrow(
      'socket closed'
    )
    expect(h.journal()?.phase).toBe('destination-staged')
    expect(h.owner()).toBe('env-1')
  })

  it.each([
    [
      'a source row changed',
      (store: Store) => store.updateRepo('repo-1', { displayName: 'Renamed' }),
      'kingud_migration_source_changed'
    ],
    [
      'a terminal started on the source',
      (store: Store) =>
        vi
          .spyOn(store, 'getSshRemotePtyLeases')
          .mockReturnValue([
            { targetId: TARGET.id, ptyId: 'late', state: 'attached', createdAt: 1, updatedAt: 1 }
          ]),
      'kingud_migration_source_terminals_live'
    ]
  ])('refuses to stage or commit after %s', async (_label, change, code) => {
    const h = await setup()
    change(h.store)
    await expect(stageKingudMigrationDestination(h.context, h.migrationId)).rejects.toThrow(code)
    expect(h.destination.stage).not.toHaveBeenCalled()
  })

  it('refuses a commit whose source changed after staging', async () => {
    const h = await setup()
    await stageKingudMigrationDestination(h.context, h.migrationId)
    h.store.updateRepo('repo-1', { displayName: 'Renamed' })
    await expect(commitKingudMigrationDestination(h.context, h.migrationId)).rejects.toThrow(
      'kingud_migration_source_changed'
    )
    expect(h.destination.commit).not.toHaveBeenCalled()
  })

  it('aborts a stage and releases the fence only once the destination proves it absent', async () => {
    const h = await setup()
    await stageKingudMigrationDestination(h.context, h.migrationId)
    await expect(abortKingudMigrationCutover(h.context, h.migrationId)).resolves.toEqual({
      outcome: 'released',
      evidence: 'catalog-absent'
    })
    expect(h.owner()).toBeNull()
    expect(h.journal()).toBeUndefined()
  })

  it('keeps the fence when the abort answer is lost and the destination cannot be read', async () => {
    const h = await setup()
    await stageKingudMigrationDestination(h.context, h.migrationId)
    h.destination.abort.mockRejectedValueOnce(new Error('socket closed'))
    h.destination.readState.mockResolvedValueOnce({
      state: 'absent',
      migrationId: h.migrationId,
      manifestSha256: h.journal()!.manifestSha256
    })
    h.destination.readState.mockRejectedValueOnce(new Error('socket closed'))
    h.destination.abort.mockRejectedValueOnce(new Error('socket closed'))
    await expect(abortKingudMigrationCutover(h.context, h.migrationId)).rejects.toThrow(
      'socket closed'
    )
    expect(h.owner()).toBe('env-1')
    expect(h.journal()?.phase).toBe('destination-staged')
  })

  it('never releases a committed destination, even when the journal lags behind it', async () => {
    const h = await setup()
    await stageKingudMigrationDestination(h.context, h.migrationId)
    await h.destination.commit(h.journal()!.manifest)
    await expect(abortKingudMigrationCutover(h.context, h.migrationId)).resolves.toMatchObject({
      outcome: 'refused',
      code: 'kingud_migration_committed_source_cannot_be_released'
    })
    expect(h.journal()?.phase).toBe('destination-committed')
    expect(h.owner()).toBe('env-1')
    await expect(abortKingudMigrationCutover(h.context, h.migrationId)).resolves.toMatchObject({
      outcome: 'refused'
    })
  })

  it('releases on an unsupported destination only before anything was staged', async () => {
    const unsupported = new Error(KINGUD_MIGRATION_DESTINATION_UNSUPPORTED)
    const fresh = await setup()
    fresh.destination.readState.mockRejectedValueOnce(unsupported)
    await expect(abortKingudMigrationCutover(fresh.context, fresh.migrationId)).resolves.toEqual({
      outcome: 'released',
      evidence: 'destination-unsupported'
    })
    expect(fresh.owner()).toBeNull()

    const staged = await setup()
    await stageKingudMigrationDestination(staged.context, staged.migrationId)
    staged.destination.readState.mockRejectedValueOnce(unsupported)
    await expect(abortKingudMigrationCutover(staged.context, staged.migrationId)).rejects.toThrow(
      KINGUD_MIGRATION_DESTINATION_UNSUPPORTED
    )
    expect(staged.owner()).toBe('env-1')
  })

  it('treats any other read failure at abort as unverifiable and keeps the fence', async () => {
    const h = await setup()
    h.destination.readState.mockRejectedValueOnce(new Error('socket closed'))
    await expect(abortKingudMigrationCutover(h.context, h.migrationId)).rejects.toThrow(
      'socket closed'
    )
    expect(h.owner()).toBe('env-1')
  })

  it('refuses a destination answer for another manifest', async () => {
    const h = await setup()
    h.destination.stage.mockResolvedValueOnce({
      state: 'staged',
      migrationId: h.migrationId,
      manifestSha256: 'f'.repeat(64),
      stagedAt: '2026-10-01T00:00:00.000Z'
    })
    await expect(stageKingudMigrationDestination(h.context, h.migrationId)).rejects.toThrow(
      'kingud_migration_destination_state_mismatch'
    )
    expect(h.journal()?.phase).toBe('source-fenced')
  })
})
