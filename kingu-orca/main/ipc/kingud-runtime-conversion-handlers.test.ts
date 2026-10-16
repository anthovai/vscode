import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  convert: vi.fn(),
  pending: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../ssh/kingud-runtime-conversion', () => ({
  convertSshTargetToManagedKingud: mocks.convert
}))
vi.mock('../ssh/kingud-managed-migration-status', () => ({
  listPendingManagedKingudMigrations: mocks.pending
}))
vi.mock('../ssh/kingud-runtime-conversion-wiring', () => ({
  conversionCollaborators: () => ({ marker: 'live-collaborators' })
}))

const { registerKingudRuntimeConversionHandlers } =
  await import('./kingud-runtime-conversion-handlers')

function handler(channel: string): (_event: unknown, args?: unknown) => unknown {
  const registration = mocks.handle.mock.calls.find(([name]) => name === channel)
  if (!registration) {
    throw new Error(`${channel} handler was not registered`)
  }
  return registration[1]
}

describe('managed server conversion IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerKingudRuntimeConversionHandlers(() => '/profile')
  })

  it('converts with the live collaborators and lists pending migrations from the profile', async () => {
    mocks.convert.mockResolvedValue({ outcome: 'converted' })
    await handler('runtimeEnvironments:convertSshHostToManagedKingud')(null, {
      sshTargetId: ' ssh-1 ',
      name: 'Builder'
    })
    expect(mocks.convert).toHaveBeenCalledWith('/profile', {
      sshTargetId: 'ssh-1',
      name: 'Builder',
      marker: 'live-collaborators'
    })
    handler('runtimeEnvironments:listPendingKingudMigrations')(null)
    expect(mocks.pending).toHaveBeenCalledWith('/profile')
  })
})
