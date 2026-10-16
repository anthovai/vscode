import { describe, expect, it, vi } from 'vitest'
import type { KingudDecommissionResult } from '../../shared/kingud-decommission'
import type { KingudTerminalCensus } from '../../shared/kingud-terminal-census'
import {
  stopWslHostServer,
  wslHostRuntimeStopSteps,
  type WslHostRuntimeAccess,
  type WslHostServerStopSteps
} from './wsl-host-server-stop'

function census(liveSessions: number | null): KingudTerminalCensus {
  return { liveSessions, startedSinceActivation: liveSessions, daemonProtocolVersion: 1 }
}

const RETIRED: KingudDecommissionResult = {
  outcome: 'decommissioned',
  version: '1.0.0',
  retirement: 'retired'
}

function steps(overrides: Partial<WslHostServerStopSteps> = {}) {
  const order: string[] = []
  const all: WslHostServerStopSteps = {
    endTerminals: vi.fn(async () => {
      order.push('endTerminals')
      return []
    }),
    census: vi.fn(async () => {
      order.push('census')
      return census(0)
    }),
    servingRuntimeId: vi.fn(async () => {
      order.push('servingRuntimeId')
      return 'runtime-a'
    }),
    closeBridge: vi.fn(async () => {
      order.push('closeBridge')
    }),
    decommission: vi.fn(async () => {
      order.push('decommission')
      return RETIRED
    }),
    sleep: vi.fn(async () => {}),
    ...overrides
  }
  return { all, order }
}

describe('stopWslHostServer', () => {
  it('closes terminals, proves none remain, names the serving kingud, then retires it', async () => {
    const { all, order } = steps()
    await expect(stopWslHostServer(all)).resolves.toEqual({ stopped: true })
    expect(order).toEqual([
      'endTerminals',
      'census',
      'servingRuntimeId',
      'closeBridge',
      'decommission'
    ])
    expect(all.decommission).toHaveBeenCalledWith(census(0), 'runtime-a')
  })

  it('names each terminal that refused, and still asks the server to stop', async () => {
    const { all } = steps({
      endTerminals: vi.fn(async () => [
        { handle: 'term_1', worktreeId: 'gone::/home/me/old', reason: 'selector_not_found' }
      ]),
      census: vi.fn(async () => census(1)),
      decommission: vi.fn(async (): Promise<KingudDecommissionResult> => ({
        outcome: 'refused',
        verdict: 'live',
        code: 'kingud_decommission_terminals_running',
        reason: '1 terminal is still running on this host.'
      }))
    })
    const result = await stopWslHostServer(all)
    expect(all.decommission).toHaveBeenCalled()
    expect(result).toEqual({
      stopped: false,
      reason:
        'Terminals that refused to close: term_1 (gone::/home/me/old): selector_not_found 1 terminal session kept running. Kingu’s server kept running: 1 terminal is still running on this host.'
    })
  })

  it('never reports stopped when the decommission could not prove it stopped the serving kingud', async () => {
    const { all } = steps({
      decommission: vi.fn(async (): Promise<KingudDecommissionResult> => ({
        outcome: 'refused',
        verdict: 'unverifiable',
        code: 'kingud_wsl_host_serving_instance_unproven',
        reason: 'the kingud this computer was connected to is not the one the distro records'
      }))
    })
    await expect(stopWslHostServer(all)).resolves.toMatchObject({ stopped: false })
  })

  it('reports a daemon that did not retire', async () => {
    const { all } = steps({
      decommission: vi.fn(async (): Promise<KingudDecommissionResult> => ({
        ...RETIRED,
        retirement: 'live'
      }))
    })
    await expect(stopWslHostServer(all)).resolves.toEqual({
      stopped: false,
      reason: 'Kingu’s server stopped, but its terminal daemon is still running.'
    })
  })
})

describe('wslHostRuntimeStopSteps', () => {
  it('closes every terminal by handle and keeps going past one that fails', async () => {
    const call = vi.fn(async (_environmentId: string, method: string, params: unknown) => {
      if (method === 'terminal.list') {
        return {
          terminals: [
            { handle: 'term_orphan', worktreeId: 'gone::/home/me/old' },
            { handle: 'term_live', worktreeId: 'app::/home/me/app' }
          ]
        }
      }
      if (method === 'terminal.close' && JSON.stringify(params).includes('term_orphan')) {
        throw new Error('selector_not_found')
      }
      return {}
    })
    const access: WslHostRuntimeAccess = { call, census: async () => census(0) }

    await expect(wslHostRuntimeStopSteps(access, 'wsl:ubuntu').endTerminals()).resolves.toEqual([
      { handle: 'term_orphan', worktreeId: 'gone::/home/me/old', reason: 'selector_not_found' }
    ])
    expect(call).toHaveBeenCalledWith('wsl:ubuntu', 'terminal.close', { terminal: 'term_live' })
    expect(call).not.toHaveBeenCalledWith('wsl:ubuntu', 'terminal.stop', expect.anything())
  })
})
