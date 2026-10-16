import { describe, expect, it, vi } from 'vitest'
import type {
  KingudMigrationCatalogAbortResult,
  KingudMigrationCatalogState,
  KingudMigrationManifest
} from '../../shared/kingud-migration-manifest'
import {
  abortStagedKingudMigrationCatalogDurably,
  commitStagedKingudMigrationCatalogDurably,
  stageKingudMigrationCatalogDurably
} from './kingud-migration-catalog-import'

describe('durable kingud migration catalog import', () => {
  it('does not acknowledge staging until its dormant manifest is durable', async () => {
    const diskError = new Error('disk full')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
    const staged = { state: 'staged' } as KingudMigrationCatalogState
    const stage = vi.fn().mockReturnValue(staged)
    const flush = vi.fn().mockRejectedValueOnce(diskError).mockResolvedValueOnce(undefined)
    const args = {
      store: {
        stageKingudMigrationCatalog: stage,
        flushPendingOrThrowAsync: flush
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
      manifest: {} as KingudMigrationManifest
    }

    await expect(stageKingudMigrationCatalogDurably(args)).rejects.toBe(diskError)
    await expect(stageKingudMigrationCatalogDurably(args)).resolves.toBe(staged)
    expect(stage).toHaveBeenCalledTimes(2)
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('publishes a committed catalog only after its receipt is durable', async () => {
    const diskError = new Error('disk full')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
    const committed = { state: 'committed' } as KingudMigrationCatalogState
    const commit = vi.fn().mockReturnValue(committed)
    const flush = vi.fn().mockRejectedValueOnce(diskError).mockResolvedValueOnce(undefined)
    const onDurableCommit = vi.fn()
    const args = {
      store: {
        commitStagedKingudMigrationCatalog: commit,
        flushPendingOrThrowAsync: flush
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
      manifest: {} as KingudMigrationManifest,
      onDurableCommit
    }

    await expect(commitStagedKingudMigrationCatalogDurably(args)).rejects.toBe(diskError)
    expect(onDurableCommit).not.toHaveBeenCalled()
    await expect(commitStagedKingudMigrationCatalogDurably(args)).resolves.toBe(committed)
    expect(onDurableCommit).toHaveBeenCalledOnce()
  })

  it('reflushes an already-absent abort after the first flush failed', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
    const aborted = { state: 'absent', aborted: true } as KingudMigrationCatalogAbortResult
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
    const unchanged = { state: 'absent', aborted: false } as KingudMigrationCatalogAbortResult
    const abort = vi.fn().mockReturnValueOnce(aborted).mockReturnValueOnce(unchanged)
    const flush = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
    const args = {
      store: {
        abortStagedKingudMigrationCatalog: abort,
        flushPendingOrThrowAsync: flush
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
      manifest: {} as KingudMigrationManifest
    }

    await expect(abortStagedKingudMigrationCatalogDurably(args)).rejects.toThrow('disk full')
    await expect(abortStagedKingudMigrationCatalogDurably(args)).resolves.toEqual({
      ...unchanged,
      durableAbsent: true
    })
    expect(flush).toHaveBeenCalledTimes(2)
  })
})
