import type {
  KingudMigrationCatalogAbortResult,
  KingudMigrationCatalogState,
  KingudMigrationManifest
} from '../../shared/kingud-migration-manifest'
import type { KingudMigrationBlobDescriptor } from '../../shared/kingud-migration-blob-transfer'
import type { Store } from '../persistence'

/** A moved history waits while a shell runs in its worktree: that shell would overwrite it. */
type WorktreeHasLiveShells = (worktreeId: string) => boolean

type KingudMigrationCatalogFlushStore = Partial<Pick<Store, 'flushPendingOrThrowAsync'>>
type KingudMigrationCatalogStageStore = KingudMigrationCatalogFlushStore &
  Partial<Pick<Store, 'stageKingudMigrationCatalog'>>
type KingudMigrationCatalogCommitStore = KingudMigrationCatalogFlushStore &
  Partial<Pick<Store, 'commitStagedKingudMigrationCatalog' | 'installKingudMigrationReceivedBlobs'>>
type KingudMigrationCatalogAbortStore = KingudMigrationCatalogFlushStore &
  Partial<Pick<Store, 'abortStagedKingudMigrationCatalog'>>

export async function stageKingudMigrationCatalogDurably(args: {
  store: KingudMigrationCatalogStageStore
  manifest: KingudMigrationManifest
  signal?: AbortSignal
}): Promise<KingudMigrationCatalogState> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.stageKingudMigrationCatalog!(args.manifest)
  await flushMigrationState(args.store, args.signal)
  return result
}

export async function commitStagedKingudMigrationCatalogDurably(args: {
  store: KingudMigrationCatalogCommitStore
  manifest: KingudMigrationManifest
  signal?: AbortSignal
  expectedBlobs?: readonly KingudMigrationBlobDescriptor[]
  onDurableCommit: () => void
  worktreeHasLiveShells?: WorktreeHasLiveShells
}): Promise<KingudMigrationCatalogState> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.commitStagedKingudMigrationCatalog!(
    args.manifest,
    args.expectedBlobs ? { expectedBlobs: args.expectedBlobs } : {}
  )
  await flushMigrationState(args.store, args.signal)
  args.onDurableCommit()
  installReceivedBlobs(args.store, args.manifest, args.worktreeHasLiveShells)
  return result
}

/** After the durable commit, on its retries and state queries; the store load retries too. */
function installReceivedBlobs(
  store: Partial<Pick<Store, 'installKingudMigrationReceivedBlobs'>>,
  manifest: KingudMigrationManifest,
  worktreeHasLiveShells: WorktreeHasLiveShells | undefined
): void {
  try {
    store.installKingudMigrationReceivedBlobs?.(manifest, { worktreeHasLiveShells })
  } catch (error) {
    // The catalog is committed; a failed install keeps its blob for the next retry.
    console.error('[kingud-migration] installing received blobs failed:', error)
  }
}

export async function abortStagedKingudMigrationCatalogDurably(args: {
  store: KingudMigrationCatalogAbortStore
  manifest: KingudMigrationManifest
  signal?: AbortSignal
}): Promise<KingudMigrationCatalogAbortResult> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.abortStagedKingudMigrationCatalog!(args.manifest)
  // An already-absent retry may follow an in-memory abort whose flush failed.
  if (result.state === 'absent') {
    await flushMigrationState(args.store, args.signal)
    return { ...result, durableAbsent: true }
  }
  return result
}

export function getKingudMigrationCatalogState(args: {
  store: Partial<
    Pick<Store, 'getKingudMigrationCatalogState' | 'installKingudMigrationReceivedBlobs'>
  >
  manifest: KingudMigrationManifest
  worktreeHasLiveShells?: WorktreeHasLiveShells
}): KingudMigrationCatalogState {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.getKingudMigrationCatalogState!(args.manifest)
  if (result.state === 'committed') {
    installReceivedBlobs(args.store, args.manifest, args.worktreeHasLiveShells)
  }
  return result
}

function flushMigrationState(
  store: KingudMigrationCatalogFlushStore,
  signal?: AbortSignal
): Promise<void> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  return store.flushPendingOrThrowAsync!({
    signal,
    drainToStableGeneration: false
  })
}
