export function pickRemoteCliEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const key of [
    'KINGU_TERMINAL_HANDLE',
    'KINGU_WORKTREE_ID',
    'KINGU_PANE_KEY',
    'KINGU_AGENT_LAUNCH_TOKEN',
    'KINGU_WORKSPACE_ID',
    'KINGU_USER_DATA_PATH',
    'PATH',
    'Path'
  ]) {
    const value = env[key]
    if (typeof value === 'string') {
      picked[key] = value
    }
  }
  return picked
}
