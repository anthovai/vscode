import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { recordManagedKingudMigration } from '../../shared/runtime-environment-managed-kingud-store'
import { kingudMigrationCutoverFixture } from './kingud-migration-cutover-fixture'
import { writeKingudMigrationSourceCutover } from './kingud-migration-cutover-journal'
import {
  createManagedLifecycleHarness,
  MANAGED_PREVIOUS_VERSION,
  MANAGED_VERSION,
  managedReadiness
} from './kingud-managed-lifecycle-test-fixture'

const mocks = vi.hoisted(() => {
  const state: { store: unknown } = { store: null }
  return {
    state,
    resolveContext: vi.fn(),
    census: vi.fn(),
    deploy: vi.fn(),
    rollback: vi.fn(),
    recover: vi.fn(),
    probe: vi.fn(),
    buildHash: vi.fn(),
    ensureTunnel: vi.fn(),
    rebuildTunnel: vi.fn(),
    wake: vi.fn(),
    pendingMigration: vi.fn()
  }
})

vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: () => ({ connect: async () => ({}) }),
  getSshTargetRegistryStore: () => mocks.state.store
}))
vi.mock('./kingud-remote-context', () => ({ resolveKingudRemoteContext: mocks.resolveContext }))
vi.mock('./kingud-terminal-census-client', () => ({ collectManagedTerminalCensus: mocks.census }))
vi.mock('./kingud-remote-deploy', () => ({ deployKingud: mocks.deploy }))
vi.mock('./kingud-remote-rollback', () => ({ rollbackKingud: mocks.rollback }))
vi.mock('./kingud-activation-recovery', () => ({
  recoverInterruptedKingudActivation: mocks.recover
}))
vi.mock('./kingud-active-readiness', () => ({ probeActiveKingudReadiness: mocks.probe }))
vi.mock('./kingud-remote-build-hash', () => ({ readRemoteKingudBuildHash: mocks.buildHash }))
vi.mock('../kingud/kingud-artifact-materializer', () => ({
  materializeKingudArtifact: async () => '/local/kingud'
}))
vi.mock('./kingud-local-build-hash', () => ({ computeLocalKingudBuildHash: () => 'local-hash' }))
vi.mock('./kingud-managed-tunnel', () => ({
  ensureKingudManagedTunnel: mocks.ensureTunnel,
  rebuildKingudManagedTunnel: mocks.rebuildTunnel
}))
vi.mock('./kingud-managed-wake', () => ({ wakeStoppedManagedKingud: mocks.wake }))
vi.mock('./kingud-managed-migration-status', () => ({
  findIncompleteManagedKingudMigration: mocks.pendingMigration
}))
vi.mock('./kingud-activation-transaction-store', () => ({
  readKingudActivationTransaction: async () => null
}))

const {
  getManagedKingudRuntimeStatus,
  recoverManagedKingudEnvironment,
  rollbackManagedKingudEnvironment,
  updateManagedKingudEnvironment
} = await import('./kingud-runtime-lifecycle')

const idle = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 7 }
let harness: ReturnType<typeof createManagedLifecycleHarness>

beforeEach(() => {
  vi.resetAllMocks()
  harness = createManagedLifecycleHarness()
  mocks.state.store = harness.targetStore
  mocks.resolveContext.mockImplementation(async () => harness.context())
  mocks.census.mockResolvedValue(idle)
  mocks.probe.mockResolvedValue(managedReadiness())
  mocks.buildHash.mockResolvedValue('previous-hash')
  mocks.recover.mockResolvedValue({ outcome: 'none' })
  mocks.wake.mockResolvedValue({ outcome: 'serving' })
})

afterEach(() => rmSync(harness.userDataPath, { recursive: true, force: true }))

describe('updateManagedKingudEnvironment', () => {
  it('defers over live or unverifiable terminals and reports the deferral in status', async () => {
    mocks.census.mockResolvedValue({ ...idle, liveSessions: null })
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '0.3.0+new',
      code: 'kingud_update_terminal_census_unavailable',
      reason: 'The terminal daemon did not answer a session count.'
    })
    const result = await updateManagedKingudEnvironment(harness.userDataPath, {
      selector: 'Managed'
    })
    expect(result).toMatchObject({ outcome: 'deferred', forceable: false })
    expect(mocks.deploy.mock.calls[0]?.[0]).toMatchObject({
      census: { liveSessions: null },
      port: 6_768,
      nodePath: ''
    })
    const status = await getManagedKingudRuntimeStatus(harness.userDataPath, 'Managed')
    expect(status.deferredUpdate).toMatchObject({
      candidateVersion: '0.3.0+new',
      code: 'kingud_update_terminal_census_unavailable'
    })
    expect(status.terminals.liveSessions).toBeNull()
  })

  it('clears the deferral once an update goes through and keeps an unchanged pairing as is', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '0.3.0+new',
      code: 'kingud_update_terminals_running',
      reason: 'busy'
    })
    await updateManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' })
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-and-activated',
      fullVersion: '0.3.0+new'
    })
    const result = await updateManagedKingudEnvironment(harness.userDataPath, {
      selector: 'Managed',
      force: true
    })
    expect(result).toMatchObject({ outcome: 'updated', activeVersion: '0.3.0+new' })
    expect(mocks.probe).toHaveBeenCalledWith(expect.anything(), {
      buildHash: 'local-hash',
      fullVersion: '0.3.0+new'
    })
    const [environment] = listEnvironments(harness.userDataPath)
    expect(environment?.pairingRevision).toBe(harness.environment.pairingRevision)
    expect(environment?.kingudDeployment).toEqual(harness.environment.kingudDeployment)
    const status = await getManagedKingudRuntimeStatus(harness.userDataPath, 'Managed')
    expect(status.deferredUpdate).toBeNull()
  })

  it('re-pairs through the same tunnel, keeping the deployment link, when the offer changed', async () => {
    mocks.deploy.mockResolvedValueOnce({ outcome: 'installed-and-activated', fullVersion: 'v3' })
    mocks.probe.mockResolvedValueOnce(managedReadiness('rotated-token'))
    await updateManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' })
    const [environment] = listEnvironments(harness.userDataPath)
    expect(environment?.endpoints[0]?.deviceToken).toBe('rotated-token')
    expect(environment?.kingudDeployment).toEqual(harness.environment.kingudDeployment)
  })
})

describe('updateManagedKingudEnvironment on a host already running this build', () => {
  beforeEach(() => {
    mocks.deploy.mockResolvedValue({ outcome: 'already-active', fullVersion: MANAGED_VERSION })
  })

  it('starts a slot proven stopped and forwards to the port it bound', async () => {
    mocks.wake.mockResolvedValueOnce({ outcome: 'started', readiness: managedReadiness() })
    await expect(
      updateManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'already-current', activeVersion: MANAGED_VERSION })
    expect(mocks.wake.mock.calls[0]?.[0]).toMatchObject({ port: 6_768 })
    expect(mocks.rebuildTunnel).toHaveBeenCalledWith(harness.userDataPath, 'environment-1')
  })

  it.each(['serving', 'unverifiable', 'fenced'] as const)(
    'leaves a %s slot alone and keeps the tunnel',
    async (outcome) => {
      mocks.wake.mockResolvedValueOnce({ outcome })
      await updateManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' })
      expect(mocks.rebuildTunnel).not.toHaveBeenCalled()
    }
  )

  it('does not wake after an activation, which launched the new slot itself', async () => {
    mocks.deploy.mockResolvedValueOnce({ outcome: 'installed-and-activated', fullVersion: 'v3' })
    await updateManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' })
    expect(mocks.wake).not.toHaveBeenCalled()
  })
})

describe('rollbackManagedKingudEnvironment', () => {
  it.each([
    [{ ...idle, liveSessions: 2 }, 'kingud_rollback_terminals_running'],
    [{ ...idle, liveSessions: null }, 'kingud_rollback_census_unavailable']
  ])('refuses while terminals run or cannot be counted: %j', async (census, code) => {
    mocks.census.mockResolvedValue(census)
    await expect(
      rollbackManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', code })
    expect(mocks.rollback).not.toHaveBeenCalled()
  })

  it('refuses with no previous version without contacting the slot', async () => {
    mocks.resolveContext.mockImplementation(async () => harness.context({ previous: null }))
    await expect(
      rollbackManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', code: 'kingud_rollback_no_target' })
    expect(mocks.census).not.toHaveBeenCalled()
  })

  it('refuses while a migration into the server is unfinished', async () => {
    mocks.pendingMigration.mockReturnValueOnce({ migrationId: 'm-1', phase: 'destination-staged' })
    await expect(
      rollbackManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', code: 'kingud_rollback_migration_in_progress' })
    expect(mocks.rollback).not.toHaveBeenCalled()
  })

  it('refuses a rollback to a snapshot older than the migrated catalog, not a newer one', async () => {
    // The harness's active version activated 2026-01-01.
    recordManagedKingudMigration(harness.userDataPath, 'environment-1', '2026-02-01T00:00:00.000Z')
    await expect(
      rollbackManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', code: 'kingud_rollback_crosses_migration' })
    expect(mocks.rollback).not.toHaveBeenCalled()
    mocks.resolveContext.mockImplementation(async () =>
      harness.context({ activatedAt: '2026-03-01T00:00:00.000Z' })
    )
    mocks.rollback.mockResolvedValueOnce({ outcome: 'refused', code: 'x', reason: 'y' })
    await rollbackManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' })
    expect(mocks.rollback).toHaveBeenCalledOnce()
  })

  it('refuses a rollback across a retained delta move that predates the mark', async () => {
    // A delta finished by an earlier build left no mark; its retained journal still counts.
    writeKingudMigrationSourceCutover(harness.userDataPath, {
      ...kingudMigrationCutoverFixture('delta-1', 'ssh-1', { environmentId: 'environment-1' }),
      startedAt: '2026-02-01T00:00:00.000Z',
      phase: 'destination-committed',
      sourceRetainedAt: '2026-02-01T00:00:00.000Z'
    })
    await expect(
      rollbackManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', code: 'kingud_rollback_crosses_migration' })
    expect(mocks.rollback).not.toHaveBeenCalled()
  })

  it('rolls back against the installed bytes of the previous slot', async () => {
    mocks.rollback.mockResolvedValueOnce({
      outcome: 'rolled-back',
      target: MANAGED_PREVIOUS_VERSION,
      discarded: [MANAGED_VERSION],
      verdict: { decision: 'activate', coverage: 'pty-spawn', warnings: [] }
    })
    await expect(
      rollbackManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'rolled-back', activeVersion: MANAGED_PREVIOUS_VERSION })
    expect(mocks.rollback.mock.calls[0]?.[0]).toMatchObject({ targetBuildHash: 'previous-hash' })
    expect(mocks.probe).toHaveBeenCalledWith(expect.anything(), {
      buildHash: 'previous-hash',
      fullVersion: MANAGED_PREVIOUS_VERSION
    })
  })
})

describe('recoverManagedKingudEnvironment', () => {
  it('passes a refusal through and leaves the server linked', async () => {
    mocks.recover.mockResolvedValueOnce({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'kingud_recovery_unverifiable',
      reason: 'host fenced'
    })
    await expect(
      recoverManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
    expect(listEnvironments(harness.userDataPath)).toHaveLength(1)
  })

  it('re-ensures the tunnel once a serving slot is restored', async () => {
    mocks.recover.mockResolvedValueOnce({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: MANAGED_VERSION,
      readiness: managedReadiness()
    })
    await expect(
      recoverManagedKingudEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'recovered', activeVersion: MANAGED_VERSION })
    expect(mocks.ensureTunnel).toHaveBeenCalledWith(harness.userDataPath, 'environment-1')
  })
})
