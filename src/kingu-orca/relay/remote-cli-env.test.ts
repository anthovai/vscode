import { describe, expect, it } from 'vitest'
import { pickRemoteCliEnv } from './remote-cli-env'

describe('pickRemoteCliEnv', () => {
  it('forwards SSH Kingu terminal and worktree context for remote CLI calls', () => {
    expect(
      pickRemoteCliEnv({
        KINGU_TERMINAL_HANDLE: 'term_ssh',
        KINGU_WORKTREE_ID: 'repo::remote',
        KINGU_PANE_KEY: 'pane-1',
        KINGU_AGENT_LAUNCH_TOKEN: 'launch-secret',
        KINGU_WORKSPACE_ID: 'workspace-1',
        KINGU_USER_DATA_PATH: '/tmp/kingu',
        PATH: '/usr/bin',
        SECRET_TOKEN: 'nope'
      })
    ).toEqual({
      KINGU_TERMINAL_HANDLE: 'term_ssh',
      KINGU_WORKTREE_ID: 'repo::remote',
      KINGU_PANE_KEY: 'pane-1',
      KINGU_AGENT_LAUNCH_TOKEN: 'launch-secret',
      KINGU_WORKSPACE_ID: 'workspace-1',
      KINGU_USER_DATA_PATH: '/tmp/kingu',
      PATH: '/usr/bin'
    })
  })
})
