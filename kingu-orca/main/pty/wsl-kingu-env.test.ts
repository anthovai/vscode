import { describe, expect, it } from 'vitest'
import { isAbsolute } from 'node:path'
import { getShellReadyWrapperRoot } from '../providers/local-pty-shell-ready-wrapper-root'
import {
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from '../../shared/setup-agent-sequencing'
import { addKinguWslInteropEnv, stampWslOrchestrationCompatibilityHost } from './wsl-kingu-env'

describe('addKinguWslInteropEnv', () => {
  it('marks the Kingu terminal handle for Windows to WSL env import', () => {
    const env: Record<string, string> = { KINGU_TERMINAL_HANDLE: 'term_wsl' }

    addKinguWslInteropEnv(env)

    expect(env.WSLENV).toBe('KINGU_TERMINAL_HANDLE/u:KINGU_SHELL_READY_ROOT/p')
  })

  // Why this is published at all: the wrapper tree is content-addressed, so the
  // in-guest login script cannot rebuild its path from KINGU_USER_DATA_PATH -- it
  // cannot derive the hash segment. Without this the guest finds no wrapper and
  // every WSL pane launches unwrapped: no ready marker, so every startup command
  // waits out the full readiness timeout.
  it('publishes the resolved wrapper root path-translated for the guest', () => {
    const env: Record<string, string> = {}

    addKinguWslInteropEnv(env)

    expect(env.KINGU_SHELL_READY_ROOT).toBe(getShellReadyWrapperRoot())
    expect(isAbsolute(env.KINGU_SHELL_READY_ROOT as string)).toBe(true)
    // /p, not /u: the guest reads a Windows path through /mnt/c.
    expect(env.WSLENV?.split(':')).toContain('KINGU_SHELL_READY_ROOT/p')
  })

  it('imports setup-gated startup env into WSL without path translation', () => {
    const env: Record<string, string> = {
      [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'codex',
      [SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]: 'while :; do sleep 1; done'
    }

    addKinguWslInteropEnv(env)

    expect(env.WSLENV?.split(':')).toEqual([
      'KINGU_SHELL_READY_ROOT/p',
      `${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}/u`,
      `${SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV}/u`
    ])
  })

  it('preserves existing WSLENV entries and does not duplicate the handle entry', () => {
    const env: Record<string, string> = {
      WSLENV: 'FOO/u:KINGU_TERMINAL_HANDLE/u:BAR/p'
    }

    addKinguWslInteropEnv(env)

    expect(env.WSLENV).toBe('FOO/u:KINGU_TERMINAL_HANDLE/u:BAR/p:KINGU_SHELL_READY_ROOT/p')
  })

  it('marks OMP status and hook env for Windows to WSL import', () => {
    const env: Record<string, string> = {
      KINGU_TERMINAL_HANDLE: 'term_wsl',
      KINGU_USER_DATA_PATH: 'C:\\Users\\jin\\AppData\\Roaming\\Kingu',
      KINGU_CLI_COMMAND: 'kingu-ide',
      KINGU_CODEX_LAUNCH_PREFLIGHT: 'C:\\Program Files\\Kingu\\resources\\bin\\kingu.exe',
      KINGU_OMP_FRESH_CONFIG: 'C:\\Kingu\\fresh-session.yml',
      KINGU_OMP_STATUS_EXTENSION: 'C:\\Users\\jin\\.omp\\agent\\extensions\\kingu-agent-status.ts',
      KINGU_PRIME_AGENT_STATUS_EXTENSION: 'C:\\stale\\kingu-agent-status.ts',
      KINGU_PANE_KEY: 'tab-1:leaf-1',
      KINGU_TAB_ID: 'tab-1',
      KINGU_WORKTREE_ID: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
      KINGU_AGENT_LAUNCH_TOKEN: 'launch-secret',
      KINGU_OPENCODE_AGENT: 'opencode2',
      KINGU_AGENT_HOOK_PORT: '4567',
      KINGU_AGENT_HOOK_TOKEN: 'token',
      KINGU_AGENT_HOOK_ENV: 'dev',
      KINGU_AGENT_HOOK_VERSION: '1',
      KINGU_AGENT_HOOK_TRANSPORT: 'raw-json-v1',
      KINGU_WSL_HOOK_INSTANCE: 'testinstance',
      KINGU_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'wsl',
      KINGU_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'local',
      KINGU_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'Ubuntu'
    }

    addKinguWslInteropEnv(env)

    expect(env.WSLENV).toContain('KINGU_TERMINAL_HANDLE/u')
    expect(env.WSLENV).toContain('KINGU_USER_DATA_PATH/p')
    expect(env.WSLENV).toContain('KINGU_CLI_COMMAND/u')
    expect(env.WSLENV).toContain('KINGU_CODEX_LAUNCH_PREFLIGHT/p')
    expect(env.WSLENV).toContain('KINGU_OMP_STATUS_EXTENSION/p')
    expect(env.WSLENV).toContain('KINGU_OMP_FRESH_CONFIG/p')
    expect(env.WSLENV).not.toContain('KINGU_PRIME_AGENT_STATUS_EXTENSION')
    expect(env.WSLENV).toContain('KINGU_PANE_KEY/u')
    expect(env.WSLENV).toContain('KINGU_TAB_ID/u')
    expect(env.WSLENV).toContain('KINGU_WORKTREE_ID/u')
    expect(env.WSLENV).toContain('KINGU_AGENT_LAUNCH_TOKEN/u')
    expect(env.WSLENV).toContain('KINGU_OPENCODE_AGENT/u')
    expect(env.WSLENV).toContain('KINGU_AGENT_HOOK_PORT/u')
    expect(env.WSLENV).toContain('KINGU_AGENT_HOOK_TOKEN/u')
    expect(env.WSLENV).toContain('KINGU_AGENT_HOOK_ENV/u')
    expect(env.WSLENV).toContain('KINGU_AGENT_HOOK_VERSION/u')
    expect(env.WSLENV).toContain('KINGU_AGENT_HOOK_TRANSPORT/u')
    expect(env.WSLENV).toContain('KINGU_WSL_HOOK_INSTANCE/u')
    expect(env.WSLENV).toContain('KINGU_ORCHESTRATION_COMPATIBILITY_HOST_KIND/u')
    expect(env.WSLENV).toContain('KINGU_ORCHESTRATION_COMPATIBILITY_HOST_ID/u')
    expect(env.WSLENV).toContain('KINGU_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION/u')
  })

  it('overwrites caller host evidence with native runtime WSL authority', () => {
    const env = {
      KINGU_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'ssh',
      KINGU_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'caller-host',
      KINGU_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'caller-incarnation',
      KINGU_ORCHESTRATION_COMPATIBILITY_ATTACHMENT: 'caller-attachment'
    }

    stampWslOrchestrationCompatibilityHost(env, 'local', 'Ubuntu')

    expect(env).toEqual({
      KINGU_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'wsl',
      KINGU_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'local',
      KINGU_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'Ubuntu'
    })
  })

  it('clears inherited host evidence outside a runtime-owned WSL scope', () => {
    const env = {
      KINGU_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'ssh',
      KINGU_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'caller-host',
      KINGU_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'caller-incarnation',
      KINGU_ORCHESTRATION_COMPATIBILITY_ATTACHMENT: 'caller-attachment'
    }

    stampWslOrchestrationCompatibilityHost(env, 'local', null)

    expect(env).toEqual({})
  })

  it('path-translates a Windows hook endpoint but passes a guest-side one untouched', () => {
    const windowsEnv: Record<string, string> = {
      KINGU_AGENT_HOOK_ENDPOINT:
        'C:\\Users\\jin\\AppData\\Roaming\\Kingu\\agent-hooks\\endpoint.cmd'
    }
    addKinguWslInteropEnv(windowsEnv)
    expect(windowsEnv.WSLENV).toContain('KINGU_AGENT_HOOK_ENDPOINT/p')

    const guestEnv: Record<string, string> = {
      KINGU_AGENT_HOOK_ENDPOINT: '/home/jin/.kingu-wsl/agent-hooks/port-4567/endpoint.env'
    }
    addKinguWslInteropEnv(guestEnv)
    expect(guestEnv.WSLENV).toContain('KINGU_AGENT_HOOK_ENDPOINT/u')
    expect(guestEnv.WSLENV).not.toContain('KINGU_AGENT_HOOK_ENDPOINT/p')
  })

  it('tags pre-translated Linux setup paths /u so WSLENV does not translate them again (#9206)', () => {
    const env: Record<string, string> = {
      KINGU_ROOT_PATH: '/home/jin/repo',
      KINGU_WORKTREE_PATH: '/home/jin/repo-worktrees/fix-1',
      KINGU_WORKSPACE_NAME: 'fix-1',
      CONDUCTOR_ROOT_PATH: '/home/jin/repo',
      GHOSTX_ROOT_PATH: '/home/jin/repo'
    }

    addKinguWslInteropEnv(env)

    // /u (not /p): hooks.ts already converted these to Linux paths before
    // spawn, so a /p flag would make WSLENV double-translate them.
    expect(env.WSLENV).toContain('KINGU_ROOT_PATH/u')
    expect(env.WSLENV).toContain('KINGU_WORKTREE_PATH/u')
    expect(env.WSLENV).toContain('CONDUCTOR_ROOT_PATH/u')
    expect(env.WSLENV).toContain('GHOSTX_ROOT_PATH/u')
    expect(env.WSLENV).not.toContain('KINGU_ROOT_PATH/p')
    expect(env.WSLENV).not.toContain('KINGU_WORKTREE_PATH/p')
    // The value itself must stay the already-Linux path.
    expect(env.KINGU_ROOT_PATH).toBe('/home/jin/repo')
    expect(env.KINGU_WORKTREE_PATH).toBe('/home/jin/repo-worktrees/fix-1')
  })

  it('tags untranslated Windows setup paths /p so WSLENV translates them (wsl.exe shell over a Windows worktree)', () => {
    const env: Record<string, string> = {
      KINGU_ROOT_PATH: 'C:\\Users\\jin\\repo',
      KINGU_WORKTREE_PATH: 'C:\\Users\\jin\\repo-worktrees\\fix-1',
      CONDUCTOR_ROOT_PATH: 'C:\\Users\\jin\\repo',
      GHOSTX_ROOT_PATH: 'C:\\Users\\jin\\repo'
    }

    addKinguWslInteropEnv(env)

    expect(env.WSLENV).toContain('KINGU_ROOT_PATH/p')
    expect(env.WSLENV).toContain('KINGU_WORKTREE_PATH/p')
    expect(env.WSLENV).toContain('CONDUCTOR_ROOT_PATH/p')
    expect(env.WSLENV).toContain('GHOSTX_ROOT_PATH/p')
    expect(env.WSLENV).not.toContain('KINGU_ROOT_PATH/u')
    expect(env.WSLENV).not.toContain('KINGU_WORKTREE_PATH/u')
  })

  it('always tags KINGU_WORKSPACE_NAME /u because it is a name, not a path', () => {
    const env: Record<string, string> = { KINGU_WORKSPACE_NAME: 'fix-1' }

    addKinguWslInteropEnv(env)

    expect(env.WSLENV).toBe('KINGU_SHELL_READY_ROOT/p:KINGU_WORKSPACE_NAME/u')
  })

  it('does not register setup vars that are absent from the env', () => {
    const env: Record<string, string> = { KINGU_TERMINAL_HANDLE: 'term_wsl' }

    addKinguWslInteropEnv(env)

    expect(env.WSLENV).toBe('KINGU_TERMINAL_HANDLE/u:KINGU_SHELL_READY_ROOT/p')
  })

  it('crosses the inline-image protocol hint into the guest untranslated (/u)', () => {
    const env: Record<string, string> = { KINGU_IMAGE_PROTOCOL: 'kitty' }
    addKinguWslInteropEnv(env)
    expect(env.WSLENV).toContain('KINGU_IMAGE_PROTOCOL/u')
  })

  it('marks the WSL hook relay version for import on relay spawn envs', () => {
    const env: Record<string, string> = {
      KINGU_WSL_HOOK_RELAY_VERSION: '0.1.0+abc'
    }
    addKinguWslInteropEnv(env)
    expect(env.WSLENV).toBe('KINGU_SHELL_READY_ROOT/p:KINGU_WSL_HOOK_RELAY_VERSION/u')
  })

  it('crosses a guest-side OpenCode config overlay untranslated (/u)', () => {
    const env: Record<string, string> = {
      OPENCODE_CONFIG_DIR: '/home/jin/.kingu-relay/opencode-overlays/abc',
      KINGU_OPENCODE_CONFIG_DIR: '/home/jin/.kingu-relay/opencode-overlays/abc'
    }
    addKinguWslInteropEnv(env)
    expect(env.WSLENV).toContain('OPENCODE_CONFIG_DIR/u')
    expect(env.WSLENV).toContain('KINGU_OPENCODE_CONFIG_DIR/u')
    expect(env.WSLENV).not.toContain('OPENCODE_CONFIG_DIR/p')
  })

  it('never crosses a Windows OpenCode config dir into the guest', () => {
    // Why: the relay spawn env spreads process.env and the daemon inherits its
    // own — a /p entry here would deliver C:\... as /mnt/c and in-guest OpenCode
    // would adopt Kingu's Windows overlay as its config root.
    const env: Record<string, string> = {
      OPENCODE_CONFIG_DIR: 'C:\\Users\\jin\\AppData\\Roaming\\Kingu\\opencode-overlays\\abc',
      KINGU_OPENCODE_CONFIG_DIR: 'C:\\Users\\jin\\AppData\\Roaming\\Kingu\\opencode-overlays\\abc'
    }
    addKinguWslInteropEnv(env)
    expect(env.WSLENV).not.toContain('OPENCODE_CONFIG_DIR')
    expect(env.WSLENV).not.toContain('KINGU_OPENCODE_CONFIG_DIR')
  })

  it('does not register the OpenCode config vars when they are absent', () => {
    const env: Record<string, string> = { KINGU_TERMINAL_HANDLE: 'term_wsl' }
    addKinguWslInteropEnv(env)
    expect(env.WSLENV).not.toContain('OPENCODE_CONFIG_DIR')
    expect(env.WSLENV).not.toContain('KINGU_OPENCODE_CONFIG_DIR')
  })
})
