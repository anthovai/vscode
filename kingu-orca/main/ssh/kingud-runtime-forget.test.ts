import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedKingudFenceEnvironmentId } from '../../shared/managed-kingud-ssh-owner'
import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  listKingudMigrationSourceCutovers,
  writeKingudMigrationSourceCutover
} from './kingud-migration-cutover-journal'
import { kingudMigrationCutoverFixture } from './kingud-migration-cutover-fixture'
import { createManagedLifecycleHarness } from './kingud-managed-lifecycle-test-fixture'
import { isManagedKingudSshTarget } from './ssh-connection-store'

const mocks = vi.hoisted(() => {
  const state: { store: unknown } = { store: null }
  return {
    state,
    connect: vi.fn(),
    resolveContext: vi.fn(),
    closeTunnel: vi.fn(),
    retire: vi.fn()
  }
})

vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: () => ({ connect: mocks.connect }),
  getSshTargetRegistryStore: () => mocks.state.store
}))
vi.mock('./kingud-remote-context', () => ({ resolveKingudRemoteContext: mocks.resolveContext }))
vi.mock('./kingud-managed-tunnel', () => ({
  closeKingudManagedTunnel: mocks.closeTunnel,
  ensureKingudManagedTunnel: vi.fn()
}))

const { forgetManagedKingudEnvironment, stopManagedKingudEnvironment } =
  await import('./kingud-runtime-lifecycle')

let harness: ReturnType<typeof createManagedLifecycleHarness>

const policy = (isActive = false) => ({
  isActiveEnvironment: () => isActive,
  retireLocalState: mocks.retire
})

beforeEach(() => {
  vi.resetAllMocks()
  harness = createManagedLifecycleHarness()
  mocks.state.store = harness.targetStore
  // The host was deleted: every connect is refused.
  mocks.connect.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:2841'))
  mocks.resolveContext.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:2841'))
})

afterEach(() => rmSync(harness.userDataPath, { recursive: true, force: true }))

describe('a managed server whose host is gone (P1-E)', () => {
  it('cannot be stopped, since the host can never prove kingud exited', async () => {
    await expect(
      stopManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' }, policy())
    ).rejects.toThrow('ECONNREFUSED')
    expect(listEnvironments(harness.userDataPath)).toHaveLength(1)
    expect(isManagedKingudSshTarget(harness.current())).toBe(true)
  })

  it('is forgotten locally without contacting the host, which frees its SSH target', async () => {
    writeKingudMigrationSourceCutover(harness.userDataPath, {
      ...kingudMigrationCutoverFixture('migration-1', 'ssh-1', { environmentId: 'environment-1' }),
      phase: 'destination-committed',
      sourceRetainedAt: '2026-10-01T00:00:00.000Z'
    })
    await expect(
      forgetManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' }, policy())
    ).resolves.toEqual({
      outcome: 'forgotten',
      // Never `exited`: nothing on the host was observed.
      verdict: 'unverifiable',
      environmentId: 'environment-1',
      sshTargetId: 'ssh-1'
    })
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.resolveContext).not.toHaveBeenCalled()
    expect(listEnvironments(harness.userDataPath)).toEqual([])
    expect(getManagedKingudFenceEnvironmentId(harness.current())).toBeNull()
    // What ssh:removeTarget checks: the host is a plain SSH target again.
    expect(isManagedKingudSshTarget(harness.current())).toBe(false)
    expect(harness.flushes).toHaveLength(1)
    expect(mocks.retire).toHaveBeenCalledWith('environment-1')
    expect(mocks.closeTunnel).toHaveBeenCalledWith('environment-1')
    expect(listKingudMigrationSourceCutovers(harness.userDataPath)).toEqual([])
  })

  it('refuses to forget the Active Server and keeps every link', async () => {
    await expect(
      forgetManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' }, policy(true))
    ).resolves.toMatchObject({ outcome: 'refused', code: 'kingud_forget_active_environment' })
    expect(listEnvironments(harness.userDataPath)).toHaveLength(1)
    expect(getManagedKingudFenceEnvironmentId(harness.current())).toBe('environment-1')
    expect(mocks.retire).not.toHaveBeenCalled()
    expect(mocks.closeTunnel).not.toHaveBeenCalled()
  })
})
