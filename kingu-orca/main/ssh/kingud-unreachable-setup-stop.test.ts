import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyKingudActivationRecord } from './kingud-activation-record'

const mocks = vi.hoisted(() => {
  const record: { active: string | null } = { active: '1.0.0+a' }
  return { stop: vi.fn(), write: vi.fn(), release: vi.fn(), record }
})
vi.mock('../../shared/runtime-environment-store', () => ({ listEnvironments: () => [] }))
vi.mock('../../shared/runtime-environment-managed-kingud-store', () => ({
  removeManagedKingudEnvironment: vi.fn()
}))
vi.mock('./kingud-migration-cutover-journal', () => ({
  findKingudMigrationSourceCutoverForTarget: () => ({
    phase: 'source-fenced',
    destinationEnvironmentId: 'env-1'
  })
}))
vi.mock('./kingud-migration-source-fence', () => ({
  releaseUndeployedMigrationFence: mocks.release
}))
vi.mock('./kingud-managed-tunnel', () => ({ closeKingudManagedTunnel: async () => undefined }))
vi.mock('./ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => ({ getTarget: () => ({ id: 'ssh-1' }) }),
  getSshConnectionManager: () => ({ connect: async () => ({}) })
}))
vi.mock('./kingud-remote-context', () => ({
  resolveKingudRemoteContext: async () => ({
    activationRecord: { ...emptyKingudActivationRecord(), active: mocks.record.active },
    connection: {},
    host: { os: 'linux' },
    remoteHome: '/home/u',
    userDataDir: '/home/u/.kingu'
  })
}))
vi.mock('./kingud-activation-lock', () => ({
  withKingudActivationLock: async (_options: unknown, run: () => Promise<unknown>) => run()
}))
vi.mock('./kingud-activation-record-store', () => ({
  readKingudActivationRecord: async () => ({
    ...emptyKingudActivationRecord(),
    active: mocks.record.active
  }),
  writeKingudActivationRecord: mocks.write
}))
vi.mock('./kingud-recovery-slot', () => ({
  kingudSlotDir: (_slot: unknown, version: string) => `/slots/${version}`,
  stopKingudSlot: mocks.stop
}))

const { releaseUnreachableKingudSetup } = await import('./kingud-unreachable-setup-release')
const release = () =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: claims pass through to the mocked fence release only.
  releaseUnreachableKingudSetup({ userDataPath: '/u', claims: {} as never, targetId: 'ssh-1' })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.record.active = '1.0.0+a'
})

describe('releasing an unreachable setup', () => {
  it('stops the kingud it activated and clears active only on proven exit', async () => {
    mocks.stop.mockResolvedValueOnce('stopped')
    await release()
    expect(mocks.stop).toHaveBeenCalledWith(expect.anything(), '/slots/1.0.0+a', false)
    expect(mocks.write.mock.calls[0]?.[1]).toMatchObject({ active: null, previous: '1.0.0+a' })
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('keeps the record when the stop is not proven, and still releases the fence', async () => {
    mocks.stop.mockResolvedValueOnce('unconfirmed')
    await release()
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('touches nothing on a host whose setup never activated', async () => {
    mocks.record.active = null
    await release()
    expect(mocks.stop).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})
