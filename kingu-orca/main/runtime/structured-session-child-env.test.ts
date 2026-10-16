import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'

const shim = vi.hoisted(() => ({ ensureLinuxTerminalKinguCliShimDir: vi.fn() }))
vi.mock('../cli/linux-terminal-kingu-cli-shim', () => shim)

import {
  SEALED_TEST_SPAWN_TOKEN,
  sealedChildEnv
} from './structured-session-child-env.test-support'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerHostScope,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from './structured-worker-identity'

const SESSION_ID = 'f7a1c0de-1111-4222-8333-444455556666'
const USER_DATA = '/data/kingu'
const RESOURCES = '/app/Resources'
const SHIM_DIR = join(USER_DATA, 'linux-kingu-cli-shim')

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

function pinPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function registerWorker(): string {
  const handle = mintStructuredWorkerHandle()
  structuredWorkerIdentities.register({
    handle,
    sessionId: SESSION_ID,
    agent: 'claude',
    paneKey: mintStructuredWorkerPaneKey(SESSION_ID),
    processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
    worktreeId: 'wt_1',
    hostScope: { kind: 'local', hostId: 'local' }
  })
  return handle
}

beforeEach(() => {
  shim.ensureLinuxTerminalKinguCliShimDir.mockReset()
  shim.ensureLinuxTerminalKinguCliShimDir.mockReturnValue(SHIM_DIR)
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: RESOURCES })
})

afterEach(() => {
  structuredWorkerIdentities.clear()
  Object.defineProperty(process, 'platform', platformDescriptor)
  if (resourcesDescriptor) {
    Object.defineProperty(process, 'resourcesPath', resourcesDescriptor)
  } else {
    Reflect.deleteProperty(process, 'resourcesPath')
  }
})

describe('sealStructuredSessionChild identity', () => {
  it("gives an ordinary chat session its own id and this app's CLI, and no terminal identity", () => {
    // The id names the caller, so a bare `kingu orchestration check` acts as this session instead of
    // guessing a terminal — every guess landed on a sibling pane, and `check` consumed its mail.
    pinPlatform('linux')
    installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
    const childEnv = { PATH: '/usr/bin' }
    const env = sealedChildEnv(SESSION_ID, childEnv)
    expect(env).toEqual({
      PATH: `${SHIM_DIR}:/usr/bin`,
      KINGU_AGENT_SESSION_ID: SESSION_ID,
      // For a CLI that predates the id, which refuses on it instead of guessing a sibling.
      KINGU_STRUCTURED_SESSION: '1',
      KINGU_CLI_COMMAND: join(SHIM_DIR, 'kingu'),
      KINGU_CLI_BIN_DIR: SHIM_DIR,
      // The instance that minted the id, so any current CLI dials it rather than the default.
      KINGU_USER_DATA_PATH: USER_DATA,
      // Empty, which the CLI reads as unset, so a profile's selector cannot send it elsewhere.
      KINGU_ENVIRONMENT: '',
      KINGU_PAIRING_CODE: '',
      KINGU_REMOTE_PAIRING: '',
      KINGU_AGENT_SESSION_SPAWN_TOKEN: SEALED_TEST_SPAWN_TOKEN
    })
    // A chat names itself by its id alone: no handle, no pane key.
    expect(env.KINGU_TERMINAL_HANDLE).toBeUndefined()
    expect(env.KINGU_PANE_KEY).toBeUndefined()
    expect(childEnv).toEqual({ PATH: '/usr/bin' })
  })

  it.each(['KINGU_ENVIRONMENT', 'KINGU_PAIRING_CODE', 'KINGU_REMOTE_PAIRING'])(
    "keeps an inherited %s from sending the agent's CLI to another server",
    (key) => {
      installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
      // A profile's export reaches both the shell snapshot a launch builds on and the server's
      // own env, which the spawn merges under the launch's overlay.
      const inherited = { PATH: '/usr/bin', [key]: 'other-server' }
      const launch = { env: sealedChildEnv(SESSION_ID, inherited) }
      const childEnv = resolveProviderChildEnv(launch, inherited)
      expect(childEnv).toMatchObject({
        KINGU_USER_DATA_PATH: USER_DATA,
        KINGU_ENVIRONMENT: '',
        KINGU_PAIRING_CODE: '',
        KINGU_REMOTE_PAIRING: ''
      })
    }
  )

  it('replaces an id inherited from an Kingu launched inside another session', () => {
    installFakeAppEnvironment({ isPackaged: () => false, getPath: () => USER_DATA })
    const env = sealedChildEnv(SESSION_ID, {
      KINGU_AGENT_SESSION_ID: 'a0b1c2d3-0000-4000-8000-00000000abcd',
      PATH: '/usr/bin'
    })
    expect(env.KINGU_AGENT_SESSION_ID).toBe(SESSION_ID)
  })

  it('gives a structured worker its id and keeps the handle it was minted', () => {
    // For orchestration the id wins and the host maps it back to this handle, so the worker keeps
    // one identity; the handle stays for the handle-based surfaces outside orchestration.
    installFakeAppEnvironment({ isPackaged: () => false, getPath: () => USER_DATA })
    const handle = registerWorker()
    const env = sealedChildEnv(SESSION_ID, { PATH: '/usr/bin' })
    expect(env.KINGU_AGENT_SESSION_ID).toBe(SESSION_ID)
    expect(env.KINGU_TERMINAL_HANDLE).toBe(handle)
  })

  describe.each(['chat', 'worker'] as const)("reaches this app's CLI as a %s", (kind) => {
    it('reaches a headless host CLI without Electron resources', () => {
      const launcher = join(USER_DATA, 'cli', 'bin', 'kingu')
      installFakeAppEnvironment({
        isPackaged: () => true,
        getPath: () => USER_DATA,
        getCliLauncherPath: () => launcher
      })
      const env = sealedChildEnv(SESSION_ID, {
        PATH: '/usr/bin',
        KINGU_USER_DATA_PATH: '/other/profile',
        KINGU_ENVIRONMENT: 'stale-shell-selection',
        KINGU_PAIRING_CODE: 'stale-pairing',
        KINGU_REMOTE_PAIRING: 'stale-remote-pairing'
      })
      expect(env.KINGU_CLI_COMMAND).toBe(launcher)
      expect(env.KINGU_USER_DATA_PATH).toBe(USER_DATA)
      expect(env).toMatchObject({
        KINGU_ENVIRONMENT: '',
        KINGU_PAIRING_CODE: '',
        KINGU_REMOTE_PAIRING: ''
      })
      expect(env.KINGU_AGENT_SESSION_ID).toBe(SESSION_ID)
      expect(env.PATH).toBe(`${join(USER_DATA, 'cli', 'bin')}:/usr/bin`)
    })
    beforeEach(() => {
      if (kind === 'worker') {
        registerWorker()
      }
    })

    it('on packaged Linux, through the bare-kingu shim, named by absolute path', () => {
      // Without this the child's first `kingu orchestration check` execs GNOME Kingu — the CLI
      // installs as `kingu-ide` on Linux (anthovai/kingu-intelligence#7904) — and the dispatch hangs to timeout.
      pinPlatform('linux')
      installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
      const env = sealedChildEnv(SESSION_ID, { PATH: '/usr/bin:/bin' })
      expect(env.KINGU_CLI_COMMAND).toBe(join(SHIM_DIR, 'kingu'))
      expect(env.PATH).toBe(`${SHIM_DIR}:/usr/bin:/bin`)
    })

    it('on packaged macOS, through the bundled CLI dir', () => {
      pinPlatform('darwin')
      installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
      const env = sealedChildEnv(SESSION_ID, { PATH: '/usr/bin' })
      expect(env.PATH).toBe(`${join(RESOURCES, 'bin')}:/usr/bin`)
      expect(env.KINGU_CLI_COMMAND).toBe(join(RESOURCES, 'bin', 'kingu'))
    })

    it('on packaged Windows, through the bundled CLI dir under the env block spelling', () => {
      pinPlatform('win32')
      installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
      const env = sealedChildEnv(SESSION_ID, { Path: 'C:\\Windows' })
      expect(env.Path).toBe(`${join(RESOURCES, 'bin')};C:\\Windows`)
      expect(env.PATH).toBeUndefined()
      // The native launcher: `kingu.cmd` refuses message bodies cmd.exe would mangle.
      expect(env.KINGU_CLI_COMMAND).toBe(join(RESOURCES, 'bin', 'kingu.exe'))
      expect(env.KINGU_CLI_BIN_DIR).toBeUndefined()
    })

    it('unpackaged, through the dev launcher dir', () => {
      pinPlatform('darwin')
      installFakeAppEnvironment({ isPackaged: () => false, getPath: () => USER_DATA })
      const env = sealedChildEnv(SESSION_ID, { PATH: '/usr/bin' })
      expect(env.PATH).toBe(`${join(USER_DATA, 'cli', 'bin')}:/usr/bin`)
      expect(env.KINGU_CLI_COMMAND).toBe(join(USER_DATA, 'cli', 'bin', 'kingu-dev'))
    })
  })

  it('omits the CLI command when no launcher resolves, never naming a bare `kingu`', () => {
    // On packaged Linux the shim can fail to resolve (no bundled launcher, an unverified AppImage);
    // a bare `kingu` there is GNOME's screen reader, and an inherited value names another app's CLI.
    pinPlatform('linux')
    installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
    shim.ensureLinuxTerminalKinguCliShimDir.mockReturnValue(null)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const env = sealedChildEnv(SESSION_ID, {
      PATH: '/usr/bin',
      KINGU_CLI_COMMAND: '/Applications/Other Kingu.app/Contents/Resources/bin/kingu',
      KINGU_USER_DATA_PATH: '/data/other-kingu'
    })
    expect(env).not.toHaveProperty('KINGU_CLI_COMMAND')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.KINGU_USER_DATA_PATH).toBe(USER_DATA)
    expect(console.warn).toHaveBeenCalledOnce()
  })

  it('never puts a pane key in the child environment', () => {
    // A pane key here flows into hook-emitted agent statuses and the attestation, agent-row and
    // mobile-projection pipelines, all of which assume it names a live PTY leaf.
    pinPlatform('linux')
    installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
    registerWorker()
    const env = sealedChildEnv(SESSION_ID, { PATH: '/usr/bin' })
    expect(env.KINGU_PANE_KEY).toBeUndefined()
    expect(Object.keys(env).filter((key) => key.includes('PANE'))).toEqual([])
  })

  it('never names the WSL-scoped launcher, because a structured worker cannot run in WSL', () => {
    // `kingu-ide` is the literal the PTY lane exports for WSL only. A structured session that
    // resolves to a WSL distro is refused a host scope, so it never becomes a worker at all —
    // which is why the bare-`kingu` shim, not the literal, is the right fix on Linux.
    expect(
      structuredWorkerHostScope({
        executionHostId: 'local',
        workspaceId: 'wt_1',
        workspaceKind: 'git-worktree',
        wslDistro: 'Ubuntu'
      })
    ).toBeNull()
    pinPlatform('linux')
    installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
    registerWorker()
    expect(sealedChildEnv(SESSION_ID, { PATH: '/usr/bin' }).KINGU_CLI_COMMAND).not.toBe('kingu-ide')
  })
})
