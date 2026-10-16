import type {
  KingudMigrationCatalogAbortResult,
  KingudMigrationCatalogState,
  KingudMigrationManifest
} from '../../shared/kingud-migration-manifest'
import type {
  KingudMigrationSnapshotChunkRequest,
  KingudMigrationSnapshotChunkResult
} from '../../shared/kingud-migration-scrollback'
import type {
  KingudMigrationBlobChunkRequest,
  KingudMigrationBlobChunkResult,
  KingudMigrationBlobDescriptor
} from '../../shared/kingud-migration-blob-transfer'
import {
  abortStagedKingudMigrationCatalogDurably,
  commitStagedKingudMigrationCatalogDurably,
  getKingudMigrationCatalogState,
  stageKingudMigrationCatalogDurably
} from './kingud-migration-catalog-import'
import { KinguRuntimeWithResolveWaiter } from './kingu-runtime-resolve-waiter'
import type { RuntimeStore } from './runtime-store-contract'

type MigrationStoreKey =
  | 'stageKingudMigrationCatalog'
  | 'commitStagedKingudMigrationCatalog'
  | 'stageKingudMigrationSnapshotChunk'
  | 'stageKingudMigrationBlobChunk'
  | 'abortStagedKingudMigrationCatalog'
  | 'getKingudMigrationCatalogState'
  | 'flushPendingOrThrowAsync'

/** The destination half of a dormant catalog migration; every mutation is flushed before it answers. */
export abstract class KinguRuntimeWithMigrationCatalog extends KinguRuntimeWithResolveWaiter {
  async stageKingudMigrationCatalog(
    manifest: KingudMigrationManifest,
    options: { signal?: AbortSignal } = {}
  ): Promise<KingudMigrationCatalogState> {
    return stageKingudMigrationCatalogDurably({
      store: this.requireMigrationStore('stageKingudMigrationCatalog', 'flushPendingOrThrowAsync'),
      manifest,
      signal: options.signal
    })
  }

  async commitStagedKingudMigrationCatalog(
    manifest: KingudMigrationManifest,
    options: { signal?: AbortSignal; expectedBlobs?: readonly KingudMigrationBlobDescriptor[] } = {}
  ): Promise<KingudMigrationCatalogState> {
    return commitStagedKingudMigrationCatalogDurably({
      store: this.requireMigrationStore(
        'commitStagedKingudMigrationCatalog',
        'flushPendingOrThrowAsync'
      ),
      manifest,
      signal: options.signal,
      expectedBlobs: options.expectedBlobs,
      worktreeHasLiveShells: this.migrationWorktreeHasLiveShells,
      onDurableCommit: () => {
        this.invalidateResolvedWorktreeCache()
        this.notifyReposChanged()
      }
    })
  }

  stageKingudMigrationSnapshotChunk(
    request: KingudMigrationSnapshotChunkRequest
  ): KingudMigrationSnapshotChunkResult {
    // SAFETY: The virtual Store may differ from the checked Store; preserve its native failure.
    return this.requireMigrationStore('stageKingudMigrationSnapshotChunk')
      .stageKingudMigrationSnapshotChunk!(request)
  }

  stageKingudMigrationBlobChunk(
    request: KingudMigrationBlobChunkRequest
  ): KingudMigrationBlobChunkResult {
    // SAFETY: The virtual Store may differ from the checked Store; preserve its native failure.
    return this.requireMigrationStore('stageKingudMigrationBlobChunk')
      .stageKingudMigrationBlobChunk!(request)
  }

  async abortStagedKingudMigrationCatalog(
    manifest: KingudMigrationManifest,
    options: { signal?: AbortSignal } = {}
  ): Promise<KingudMigrationCatalogAbortResult> {
    return abortStagedKingudMigrationCatalogDurably({
      store: this.requireMigrationStore(
        'abortStagedKingudMigrationCatalog',
        'flushPendingOrThrowAsync'
      ),
      manifest,
      signal: options.signal
    })
  }

  getKingudMigrationCatalogState(manifest: KingudMigrationManifest): KingudMigrationCatalogState {
    return getKingudMigrationCatalogState({
      store: this.requireMigrationStore('getKingudMigrationCatalogState'),
      manifest,
      worktreeHasLiveShells: this.migrationWorktreeHasLiveShells
    })
  }

  /**
   * The moved shell history store load left waiting, installed once this runtime can see the
   * host's shells. An unanswered inventory leaves it for the next catalog-state query.
   */
  async installPendingKingudMigrationShellHistory(): Promise<void> {
    const store = this.store
    if (!store?.installPendingKingudMigrationReceivedBlobs) {
      return
    }
    // Daemon shells that outlived a restart count as live only once the inventory recorded them.
    if (
      this.ptyController?.listProcesses &&
      !(await this.refreshPtyWorktreeRecordsWithControllerInventory([]))
    ) {
      console.warn('[kingud-migration] shell history waits: the terminal inventory did not answer')
      return
    }
    store.installPendingKingudMigrationReceivedBlobs({
      worktreeHasLiveShells: this.migrationWorktreeHasLiveShells
    })
  }

  // The last shell of a worktree exiting releases a moved history that waited on it.
  override onPtyExit(
    ...args: Parameters<KinguRuntimeWithResolveWaiter['onPtyExit']>
  ): ReturnType<KinguRuntimeWithResolveWaiter['onPtyExit']> {
    const worktreeId = this.ptysById.get(args[0])?.worktreeId
    const result = super.onPtyExit(...args)
    // The store checks its deferred set first, so an exit in any other worktree costs one lookup.
    if (worktreeId) {
      try {
        this.store?.installDeferredKingudMigrationShellHistory?.(worktreeId, {
          worktreeHasLiveShells: this.migrationWorktreeHasLiveShells
        })
      } catch (error) {
        console.error('[kingud-migration] installing deferred shell history failed:', error)
      }
    }
    return result
  }

  private readonly migrationWorktreeHasLiveShells = (worktreeId: string): boolean =>
    this.getLivePtyIdsForWorktree(worktreeId).size > 0

  // The capability check covers the captured Store, not a different virtual return.
  private requireMigrationStore(...methods: MigrationStoreKey[]): RuntimeStore {
    const store = this.store
    if (!store || methods.some((method) => typeof store[method] !== 'function')) {
      throw new Error('runtime_unavailable')
    }
    return this.requireStore()
  }
}
