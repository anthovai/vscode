import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KingudHostTransport } from './kingud-host-transport'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const execKingudRemote = vi.hoisted(() => vi.fn())
vi.mock('./kingud-remote-runtime-control', () => ({ execKingudRemote }))
const resolveKingudRemoteContext = vi.hoisted(() => vi.fn())
vi.mock('./kingud-remote-context', () => ({ resolveKingudRemoteContext }))

import {
  kingudBoundPort,
  readManagedKingudBoundPort,
  resolveManagedKingudTunnelPort
} from './kingud-managed-bound-port'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'

function readinessLine(boundEndpoint: string | null): string {
  return `${JSON.stringify({ type: 'kingu_server_ready', runtimeId: 'runtime-1', boundEndpoint })}\n`
}

function slot() {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exec is mocked; the connection is never used.
    conn: {} as KingudHostTransport,
    host: getRemoteHostPlatform('linux-x64'),
    remoteInstallDir: '/home/deploy/.kingu-kingud/1.0.0'
  }
}

describe('kingudBoundPort', () => {
  it('reads the port kingud actually bound', () => {
    expect(kingudBoundPort({ boundEndpoint: 'ws://127.0.0.1:58520' })).toBe(58_520)
  })

  it.each([null, 'not a url', 'ws://127.0.0.1'])('returns null for %s', (boundEndpoint) => {
    expect(kingudBoundPort({ boundEndpoint })).toBeNull()
  })
})

describe('readManagedKingudBoundPort', () => {
  beforeEach(() => {
    execKingudRemote.mockReset()
  })

  it('follows kingud off a preferred port another runtime holds', async () => {
    execKingudRemote.mockResolvedValue(readinessLine('ws://127.0.0.1:58520'))
    await expect(readManagedKingudBoundPort(slot(), 6_768)).resolves.toBe(58_520)
  })

  it.each([
    ['no readiness file', ''],
    ['a readiness without an endpoint', readinessLine(null)]
  ])('falls back to the preferred port for %s (older builds)', async (_label, output) => {
    execKingudRemote.mockResolvedValue(output)
    await expect(readManagedKingudBoundPort(slot(), 6_768)).resolves.toBe(6_768)
  })

  it('surfaces a failed host read instead of guessing a port', async () => {
    execKingudRemote.mockImplementation(async () => {
      throw new Error('channel closed')
    })
    await expect(readManagedKingudBoundPort(slot(), 6_768)).rejects.toThrow('channel closed')
  })
})

describe('resolveManagedKingudTunnelPort', () => {
  const link = {
    sshTargetId: 'ssh-1',
    sshTargetGeneration: 1,
    localPort: 46_768,
    remotePort: 6_768
  }
  function input(kind: 'kingudDeployment' | 'sshAccess') {
    return {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only the link fields.
      environment: { [kind]: link } as unknown as KnownRuntimeEnvironment,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: passed through to the mocked context.
      target: { id: 'ssh-1' } as SshTarget,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: passed through to the mocked context.
      connection: {} as KingudHostTransport
    }
  }

  beforeEach(() => {
    execKingudRemote.mockReset()
    resolveKingudRemoteContext.mockReset()
  })

  it('reads the active slot of a managed server', async () => {
    resolveKingudRemoteContext.mockResolvedValue({
      activationRecord: { active: '1.0.0+abc' },
      connection: {},
      host: getRemoteHostPlatform('linux-x64'),
      remoteHome: '/home/deploy'
    })
    execKingudRemote.mockResolvedValue(readinessLine('ws://127.0.0.1:58520'))
    await expect(resolveManagedKingudTunnelPort(input('kingudDeployment'))).resolves.toBe(58_520)
  })

  it('keeps the configured port for independent SSH access without touching the host', async () => {
    await expect(resolveManagedKingudTunnelPort(input('sshAccess'))).resolves.toBe(6_768)
    expect(resolveKingudRemoteContext).not.toHaveBeenCalled()
  })

  it('tries the preferred port when the host cannot be read; the identity check still guards it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveKingudRemoteContext.mockRejectedValue(new Error('platform probe failed'))
    await expect(resolveManagedKingudTunnelPort(input('kingudDeployment'))).resolves.toBe(6_768)
    warn.mockRestore()
  })
})
