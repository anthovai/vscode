import type { FsChangedPayload } from '../../../shared/filesystem-entry-types'

export const KINGU_WORKTREE_FILE_CHANGE_EVENT = 'kingu:worktree-file-change'

export type WorktreeFileChangeEventDetail = {
  payload: FsChangedPayload
  runtimeEnvironmentId: string | null
}
