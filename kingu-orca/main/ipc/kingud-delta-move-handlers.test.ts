import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  move: vi.fn(),
  keep: vi.fn(async () => {}),
  publish: vi.fn(),
  target: {
    id: 'ssh-1',
    label: 'Box',
    host: 'box',
    port: 22,
    username: 'me',
    kingudFence: { environmentId: 'env-1', sourceChangedAt: '2026-10-04T00:00:00.000Z' }
  }
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: () => [{ id: 'env-1' }]
}))
vi.mock('../ssh/kingud-managed-runtime-context', () => ({
  requireManagedKingudInfrastructure: () => ({
    claims: {},
    targetStore: { getKingudMigrationSource: () => ({ getSshTarget: () => mocks.target }) }
  })
}))
vi.mock('../ssh/kingud-migration-delta-move', () => ({
  runKingudDeltaMove: mocks.move,
  keepKingudServerVersion: mocks.keep
}))
vi.mock('../ssh/kingud-runtime-conversion-wiring', () => ({
  kingudMigrationDestinationFor: () => ({})
}))
vi.mock('../ssh/kingud-managed-tunnel', () => ({
  ensureKingudManagedTunnel: vi.fn()
}))
vi.mock('./ssh-session-teardown', () => ({
  disconnectRegisteredSshTarget: vi.fn()
}))
vi.mock('./runtime-environment-managed-tunnel', () => ({
  publishResolvedChangedHostStatus: mocks.publish
}))

const { registerKingudDeltaMoveHandlers } = await import('./kingud-delta-move-handlers')

function handler(channel: string): (_event: unknown, args: unknown) => Promise<unknown> {
  const registration = mocks.handle.mock.calls.find(([name]) => name === channel)
  if (!registration) {
    throw new Error(`${channel} handler was not registered`)
  }
  return registration[1]
}

describe('resolving a host an older build changed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerKingudDeltaMoveHandlers(() => '/tmp/user-data')
  })

  it('refreshes the host status once the move lands, and not when it is refused', async () => {
    mocks.move.mockResolvedValueOnce({ outcome: 'refused', code: 'x', reason: 'y' })
    await handler('runtimeEnvironments:moveKingudDelta')(null, { sshTargetId: 'ssh-1' })
    expect(mocks.publish).not.toHaveBeenCalled()
    mocks.move.mockResolvedValueOnce({ outcome: 'moved', migrationId: 'm' })
    await handler('runtimeEnvironments:moveKingudDelta')(null, { sshTargetId: 'ssh-1' })
    expect(mocks.publish).toHaveBeenCalledWith(mocks.target, 'env-1')
  })

  it('refreshes the host status after keeping the server version', async () => {
    await handler('runtimeEnvironments:keepKingudServerVersion')(null, { sshTargetId: 'ssh-1' })
    expect(mocks.keep).toHaveBeenCalled()
    expect(mocks.publish).toHaveBeenCalledWith(mocks.target, 'env-1')
  })
})
