export const KINGU_EDITOR_SAVE_DIRTY_FILES_EVENT = 'kingu:editor-save-dirty-files'
export const KINGU_EDITOR_PREPARE_HOT_EXIT_EVENT = 'kingu:editor-prepare-hot-exit'

export type EditorSaveDirtyFilesDetail = {
  claim: () => void
  resolve: () => void
  reject: (message: string) => void
}

export type EditorPrepareHotExitDetail = EditorSaveDirtyFilesDetail
