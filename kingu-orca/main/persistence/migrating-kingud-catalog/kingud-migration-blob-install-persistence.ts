import type { KingudMigrationManifest } from '../../../shared/kingud-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { getHistoryRoot } from '../../terminal-history-paths'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { findKingudMigrationImportReceipt } from './kingud-catalog-receipt-ledger'
import { installKingudMigrationReceivedBlobs } from './kingud-migration-blob-installers'
import type { KingudMigrationRequestIdentity } from './kingud-migration-staged-file'

type KingudMigrationBlobInstallRuntime = Pick<
  StoreRuntimeState,
  | 'state'
  | 'kingudMigrationBlobRoot'
  | 'kingudTerminalRestoreHints'
  | 'paneShellPath'
  | 'deferredShellHistoryWorktreeIds'
>

type ClockOptions = { now?: () => Date }
type InstallOptions = ClockOptions & {
  /** The runtime's live-shell check; a moved history waits while a shell runs in its worktree. */
  worktreeHasLiveShells?: (worktreeId: string) => boolean
}

const kingudMigrationBlobInstallContext = Symbol('KingudMigrationBlobInstallPersistence')
type KingudMigrationBlobInstallContext = {
  runtime: KingudMigrationBlobInstallRuntime
}

/** The destination's committed migration blobs, installed into host-local state and consumed. */
export class KingudMigrationBlobInstallPersistence {
  readonly [kingudMigrationBlobInstallContext]: KingudMigrationBlobInstallContext

  constructor(runtime: KingudMigrationBlobInstallRuntime) {
    this[kingudMigrationBlobInstallContext] = { runtime }
  }

  /**
   * Run only once the commit is durable: installing first and then losing the commit would leave
   * live hints or history for a catalog this host never received. A no-op before commit and on
   * repeats.
   */
  installKingudMigrationReceivedBlobs(
    manifest: KingudMigrationManifest,
    options: InstallOptions = {}
  ): void {
    const receipt = findKingudMigrationImportReceipt(
      this[kingudMigrationBlobInstallContext].runtime.state,
      manifest
    )
    if (receipt?.manifestSha256 !== manifest.manifestSha256) {
      return
    }
    installCommitted(this[kingudMigrationBlobInstallContext].runtime, manifest, options)
  }

  /** Finishes installs a crash or failed write left behind; every receipt on disk is durable. */
  installPendingKingudMigrationReceivedBlobs(options: InstallOptions = {}): void {
    const { runtime } = this[kingudMigrationBlobInstallContext]
    for (const receipt of [
      ...(runtime.state.kingudMigrationImportReceipts ?? []),
      ...(runtime.state.kingudMigrationEvictedReceipts ?? [])
    ]) {
      try {
        installCommitted(runtime, receipt, options)
      } catch (error) {
        console.error(
          `[kingud-migration] installing received blobs for ${receipt.migrationId} failed:`,
          error
        )
      }
    }
  }

  /** Retries a history install that waited on this worktree's shells; a no-op for any other. */
  installDeferredKingudMigrationShellHistory(
    worktreeId: string,
    options: InstallOptions = {}
  ): void {
    const { runtime } = this[kingudMigrationBlobInstallContext]
    if (runtime.deferredShellHistoryWorktreeIds.has(worktreeId)) {
      this.installPendingKingudMigrationReceivedBlobs(options)
    }
  }

  /** The moved pane's last folder while its hint is installed for this worktree; never removes it. */
  peekKingudMigrationTerminalRestoreHint(
    paneKey: string,
    worktreeId: string,
    options: ClockOptions = {}
  ): string | null {
    return this[kingudMigrationBlobInstallContext].runtime.kingudTerminalRestoreHints.peek(
      paneKey,
      worktreeId,
      clock(options)
    )
  }

  /** Called once the pane spawned: whatever cwd that create used, it was the restore. */
  consumeKingudMigrationTerminalRestoreHint(paneKey: string, options: ClockOptions = {}): void {
    this[kingudMigrationBlobInstallContext].runtime.kingudTerminalRestoreHints.consume(
      paneKey,
      clock(options)
    )
  }
}

function installCommitted(
  runtime: KingudMigrationBlobInstallRuntime,
  migration: KingudMigrationRequestIdentity,
  options: InstallOptions
): void {
  installKingudMigrationReceivedBlobs({
    migration,
    root: runtime.kingudMigrationBlobRoot,
    terminalRestoreHints: runtime.kingudTerminalRestoreHints,
    shellHistoryRoot: getHistoryRoot(),
    paneShellPath: () => runtime.paneShellPath(runtime.state.settings?.terminalDefaultShell),
    worktreeHasLiveShells: options.worktreeHasLiveShells,
    deferredShellHistoryWorktreeIds: runtime.deferredShellHistoryWorktreeIds,
    paneWorktreeId: (paneKey) => findPaneWorktreeId(runtime.state, paneKey),
    now: clock(options)
  })
}

function clock(options: ClockOptions): number {
  return (options.now ?? (() => new Date()))().getTime()
}

// The commit merged the moved session in with its worktree ids unchanged.
function findPaneWorktreeId(state: PersistedState, paneKey: string): string | null {
  const tabId = parsePaneKey(paneKey)?.tabId
  if (!tabId) {
    return null
  }
  const sessions = [state.workspaceSession, ...Object.values(state.workspaceSessionsByHostId ?? {})]
  for (const session of sessions) {
    for (const [worktreeId, tabs] of Object.entries(session?.tabsByWorktree ?? {})) {
      if (tabs.some((tab) => tab.id === tabId)) {
        return worktreeId
      }
    }
  }
  return null
}
