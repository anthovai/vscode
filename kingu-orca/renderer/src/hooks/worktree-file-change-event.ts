import type { FsChangedPayload } from '../../../shared/filesystem-entry-types'

export const KINGU_WORKTREE_FILE_CHANGE_EVENT = 'kingu:worktree-file-change'

export type WorktreeFileChangeEventDetail = {
  payload: FsChangedPayload
  runtimeEnvironmentId: string | null
}

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- WindowEventMap requires declaration merging.
  interface WindowEventMap {
    'kingu:worktree-file-change': CustomEvent<WorktreeFileChangeEventDetail>
  }
}
