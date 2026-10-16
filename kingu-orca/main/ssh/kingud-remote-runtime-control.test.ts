import type * as ExecCommandModule from './ssh-relay-exec-command'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error && error.message === 'unconfirmed'
}))

import { execCommand } from './ssh-relay-exec-command'
import { launchKingudAndAwaitReadiness } from './kingud-remote-runtime-control'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { KingudLaunchSpec } from './kingud-remote-launch'
import { createSshOperationAbortError } from './ssh-connection-utils'

const host = getRemoteHostPlatform('linux-arm64')
const spec: KingudLaunchSpec = {
  remoteInstallDir: '/root/.kingu-remote/kingud-0.1.0+07d0995735e0',
  nodePath: '/usr/bin/node',
  fullVersion: '0.1.0+07d0995735e0',
  userDataDir: '/root/.kingu',
  bindHost: '127.0.0.1',
  port: 6768,
  activationRoot: '/root/.kingu-remote/.kingud-activation-transaction'
}
const READY = `${JSON.stringify({ type: 'kingu_server_ready', runtimeId: 'r1' })}\n`
const mockExec = vi.mocked(execCommand)

function launch(signal?: AbortSignal) {
  return launchKingudAndAwaitReadiness(
    { conn: Object.create(null), host, readinessTimeoutMs: 60_000, sleep: async () => {}, signal },
    spec
  )
}

describe('waiting for a launched candidate', () => {
  beforeEach(() => {
    mockExec.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  // BUG-17: one failed read of the readiness file failed the launch, and the activation then
  // stopped a candidate that went ready a moment later.
  it('retries a failed readiness read instead of failing the launch', async () => {
    mockExec
      .mockResolvedValueOnce('1786\n')
      .mockRejectedValueOnce(new Error('(SSH) Channel open failure: open failed'))
      .mockResolvedValueOnce(READY)
    await expect(launch()).resolves.toMatchObject({
      state: 'ready',
      readiness: { runtimeId: 'r1' }
    })
  })

  it('still fails at once on an unconfirmed termination, which may have run remotely', async () => {
    mockExec.mockResolvedValueOnce('1786\n').mockRejectedValueOnce(new Error('unconfirmed'))
    await expect(launch()).rejects.toThrow('unconfirmed')
  })

  it('stops retrying a readiness read that the retired SSH transport cancelled', async () => {
    const cancelled = createSshOperationAbortError()
    mockExec
      .mockResolvedValueOnce('1786\n')
      .mockRejectedValueOnce(cancelled)
      .mockResolvedValueOnce(READY)
    await expect(launch()).rejects.toBe(cancelled)
    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  it('rejects a readiness reply received after its caller cancelled', async () => {
    const controller = new AbortController()
    mockExec.mockResolvedValueOnce('1786\n').mockImplementationOnce(async () => {
      controller.abort()
      return READY
    })
    await expect(launch(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
