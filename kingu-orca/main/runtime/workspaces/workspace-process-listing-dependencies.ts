import type { RuntimeWorkspaceCatalog } from './workspace-catalog'
import type { KinguRuntimeWithRefreshPtyWorktreeRecordsFromController } from '../terminal/lifecycle/pty-worktree-refresh'
import type { RuntimeAccountController } from '../runtime-account-controller'
import type { KinguRuntimeWithPruneMobileSessionTabGroupLayout } from '../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import type { KinguRuntimeWithGetStructuredAgentSessionCreateSupport } from '../session-tabs/structured-session-create-support'
import type { KinguRuntimeWithGetPtyRecordForPaneKey } from '../orchestration/terminal-pane-mail-routing'
import { KinguRuntimeWithStartTuiIdleVisibleReadProbe } from '../terminal/wait/terminal-wait-visible-probe'

/** Members the worktree listing reads from later runtime layers; declarations only. */
export abstract class KinguRuntimeWithWorktreePsDependencies extends KinguRuntimeWithStartTuiIdleVisibleReadProbe {
  protected abstract listResolvedWorktreeSnapshot(
    ...args: Parameters<RuntimeWorkspaceCatalog['listResolvedWorktreeSnapshot']>
  ): ReturnType<RuntimeWorkspaceCatalog['listResolvedWorktreeSnapshot']>
  protected abstract refreshPtyWorktreeRecordsFromController(
    ...args: Parameters<
      KinguRuntimeWithRefreshPtyWorktreeRecordsFromController['refreshPtyWorktreeRecordsFromController']
    >
  ): ReturnType<
    KinguRuntimeWithRefreshPtyWorktreeRecordsFromController['refreshPtyWorktreeRecordsFromController']
  >
  abstract notifyFolderWorkspaceChanged(): void
  abstract notifyBranchRenamed(repoId: string): void
  abstract notifyWorktreeFolderRenamed(
    repoId: string,
    oldWorktreeId: string,
    newWorktreeId: string
  ): void
  declare getCommitMessageAgentEnvironmentResolvers: RuntimeAccountController['getCommitMessageAgentEnvironment']
  abstract refreshStructuredConversationTabTitle(
    ...args: Parameters<
      KinguRuntimeWithPruneMobileSessionTabGroupLayout['refreshStructuredConversationTabTitle']
    >
  ): ReturnType<
    KinguRuntimeWithPruneMobileSessionTabGroupLayout['refreshStructuredConversationTabTitle']
  >
  abstract resolveStructuredAgentAccountHome(
    ...args: Parameters<
      KinguRuntimeWithGetStructuredAgentSessionCreateSupport['resolveStructuredAgentAccountHome']
    >
  ): ReturnType<
    KinguRuntimeWithGetStructuredAgentSessionCreateSupport['resolveStructuredAgentAccountHome']
  >
  abstract onStructuredSessionStatusForMail(
    ...args: Parameters<KinguRuntimeWithGetPtyRecordForPaneKey['onStructuredSessionStatusForMail']>
  ): ReturnType<KinguRuntimeWithGetPtyRecordForPaneKey['onStructuredSessionStatusForMail']>
  abstract onStructuredSessionTabHidden(
    ...args: Parameters<KinguRuntimeWithGetPtyRecordForPaneKey['onStructuredSessionTabHidden']>
  ): ReturnType<KinguRuntimeWithGetPtyRecordForPaneKey['onStructuredSessionTabHidden']>
}
