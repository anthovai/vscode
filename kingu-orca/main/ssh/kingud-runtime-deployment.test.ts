import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAppEnvironment } from '../../shared/app-environment'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { getManagedKingudFenceEnvironmentId } from '../../shared/managed-kingud-ssh-owner'
import { writeKingudMigrationSourceCutover } from './kingud-migration-cutover-journal'
import { kingudMigrationCutoverFixture } from './kingud-migration-cutover-fixture'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { SshTarget } from '../../shared/ssh-types'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { SshTargetKingudClaims } from './ssh-target-kingud-claims'
import { emptyDependentStateStore } from './ssh-target-kingud-dependents-fixture'
import {
  withDeactivatedVersion,
  withDeactivatedVersionCommitted,
  type KingudActivationRecord
} from './kingud-activation-record'
import { KINGUD_ACTIVATION_POLICY_REFUSED_CODE } from './kingud-installed-activation'
import type { KingudDeployOptions } from './kingud-remote-deploy'

const mocks = vi.hoisted(() => {
  const state: { store: unknown } = { store: null }
  return {
    state,
    events: new Array<string>(),
    connect: vi.fn(),
    resolveContext: vi.fn(),
    recover: vi.fn(),
    readRecord: vi.fn(),
    deploy: vi.fn(),
    probe: vi.fn(),
    startTunnel: vi.fn(),
    ensureTunnel: vi.fn(),
    closeTunnel: vi.fn(),
    readTransaction: vi.fn(),
    wake: vi.fn(),
    localVersion: vi.fn(),
    fenceRefusal: vi.fn()
  }
})

vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: () => ({ connect: mocks.connect }),
  getSshTargetRegistryStore: () => mocks.state.store
}))
vi.mock('./kingud-remote-context', () => ({ resolveKingudRemoteContext: mocks.resolveContext }))
vi.mock('./kingud-activation-recovery', () => ({
  recoverInterruptedKingudActivation: mocks.recover
}))
vi.mock('./kingud-activation-record-store', () => ({
  readKingudActivationRecord: mocks.readRecord
}))
vi.mock('./kingud-activation-transaction-store', () => ({
  readKingudActivationTransaction: mocks.readTransaction
}))
vi.mock('./kingud-remote-deploy', () => ({ deployKingud: mocks.deploy }))
vi.mock('../kingud/kingud-artifact-materializer', () => ({
  materializeKingudArtifact: async () => '/local/kingud'
}))
vi.mock('./kingud-managed-wake', () => ({ wakeStoppedManagedKingud: mocks.wake }))
vi.mock('./kingud-activation-fence-hold', () => ({
  kingudActivationFenceRefusal: mocks.fenceRefusal
}))
vi.mock('./kingud-remote-build-hash', () => ({
  readRemoteKingudBuildHash: async () => 'running-hash'
}))
vi.mock('./remote-versioned-install', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readLocalFullVersion: mocks.localVersion
}))
vi.mock('./kingud-local-build-hash', () => ({ computeLocalKingudBuildHash: () => 'build-hash' }))
vi.mock('./kingud-active-readiness', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  probeActiveKingudReadiness: mocks.probe
}))
vi.mock('./kingud-terminal-census-client', () => ({
  collectManagedTerminalCensus: async () => ({
    liveSessions: 0,
    startedSinceActivation: 0,
    daemonProtocolVersion: 39
  })
}))
vi.mock('./kingud-managed-tunnel', () => ({
  startKingudManagedTunnel: mocks.startTunnel,
  ensureKingudManagedTunnel: mocks.ensureTunnel,
  closeKingudManagedTunnel: mocks.closeTunnel
}))

const { createManagedKingudEnvironment, getManagedKingudRuntimeStatus } =
  await import('./kingud-runtime-lifecycle')

const VERSION = '0.1.0+abc123'
const emptyRecord = { active: null, previous: null, activatedAt: null, snapshot: null }

function readiness(endpoint = 'ws://127.0.0.1:6768') {
  return {
    runtimeId: 'runtime-1',
    boundEndpoint: endpoint,
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: {
      available: true,
      url: encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint,
        deviceToken: 'device-token',
        publicKeyB64: 'public-key'
      }),
      endpoint,
      deviceId: 'device-1',
      webClientUrl: null,
      scope: 'runtime',
      qr: null
    }
  }
}

let userDataPath: string
let target: SshTarget
let flushes: number

function setupStore(overrides: { repos?: { connectionId: string }[] } = {}) {
  const store = {
    allocateSshTargetGeneration: () => 9,
    flushPendingOrThrowAsync: async () => {
      flushes += 1
      mocks.events.push('flush')
    },
    getFolderWorkspaces: () => [],
    getRepos: () => overrides.repos ?? [],
    ...emptyDependentStateStore(),
    getSshTarget: (id: string) => (id === target.id ? target : undefined),
    getSshTargets: () => [target],
    updateSshTarget: (_id: string, updates: Partial<SshTarget>) => {
      target = { ...target, ...updates }
      return target
    }
  }
  mocks.state.store = {
    getTarget: (id: string) => (id === target.id ? target : undefined),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the claims read only the store methods stubbed above.
    getKingudRuntimeClaims: () => new SshTargetKingudClaims(store as never)
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.events.length = 0
  flushes = 0
  userDataPath = mkdtempSync(join(tmpdir(), 'kingud-deployment-test-'))
  target = { id: 'ssh-1', label: 'Builder', host: 'builder', port: 22, username: 'dev' }
  setupStore()
  mocks.connect.mockImplementation(async () => {
    mocks.events.push('connect')
    return {}
  })
  mocks.resolveContext.mockImplementation(async (claimed: SshTarget) => ({
    activationRecord: emptyRecord,
    serverTarget: 'linux-x64-glibc',
    connection: {},
    host: getRemoteHostPlatform('linux-x64'),
    remoteHome: '/home/dev',
    target: claimed,
    userDataDir: '/home/dev/.kingu'
  }))
  mocks.recover.mockResolvedValue({ outcome: 'none' })
  mocks.deploy.mockResolvedValue({ outcome: 'installed-and-activated', fullVersion: VERSION })
  mocks.probe.mockResolvedValue(readiness())
  mocks.startTunnel.mockResolvedValue(46_768)
  mocks.closeTunnel.mockResolvedValue(undefined)
  mocks.ensureTunnel.mockResolvedValue(undefined)
  mocks.localVersion.mockReturnValue(VERSION)
  mocks.wake.mockResolvedValue({ outcome: 'serving' })
})

afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

const deploy = () =>
  createManagedKingudEnvironment(userDataPath, { name: 'Managed', sshTargetId: 'ssh-1' })

describe('createManagedKingudEnvironment', () => {
  it('claims the target durably before contacting it, then registers a tunneled server', async () => {
    const result = await deploy()

    expect(mocks.events.slice(0, 2)).toEqual(['flush', 'connect'])
    expect(result).toMatchObject({ outcome: 'created', activeVersion: VERSION })
    const [environment] = listEnvironments(userDataPath)
    expect(environment?.kingudDeployment).toEqual({
      sshTargetId: 'ssh-1',
      sshTargetGeneration: 9,
      localPort: 46_768,
      remotePort: 6_768
    })
    expect(environment?.connectionDependency).toBe('ssh-tunnel')
    expect(getManagedKingudFenceEnvironmentId(target)).toBe(environment?.id)
    expect(target.kingudProvisioning).toEqual({ requestId: environment?.id, name: 'Managed' })
    expect(JSON.stringify(result)).not.toContain('device-token')
    expect(mocks.probe).toHaveBeenCalledWith(
      expect.objectContaining({ remoteInstallDir: expect.any(String) }),
      {
        buildHash: 'build-hash',
        fullVersion: VERSION
      }
    )
    expect(mocks.closeTunnel).not.toHaveBeenCalled()
  })

  it('tunnels to the port kingud bound when 6768 is taken, and keeps 6768 as its launch port', async () => {
    mocks.probe.mockResolvedValue(readiness('ws://127.0.0.1:58520'))
    await deploy()

    const [, , , remotePort, checks] = mocks.startTunnel.mock.calls[0] ?? []
    expect(remotePort).toBe(58_520)
    expect(checks).toMatchObject({ preferredPort: 6_768 })
    expect(listEnvironments(userDataPath)[0]?.kingudDeployment?.remotePort).toBe(6_768)
  })

  it('deploys an empty host with a zero census and an unknown one over an active slot', async () => {
    await deploy()
    expect(mocks.deploy.mock.calls[0]?.[0]).toMatchObject({
      census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null },
      nodePath: ''
    })
    // SSH hosts keep re-hashing the runtime on every deploy.
    expect(mocks.deploy.mock.calls[0]?.[0]).not.toHaveProperty('recordedNodeRuntimeProbe')
  })

  describe('admitting a host another desktop stopped, under the fence', () => {
    const servedBy = (appVersion: string | null, active: string): KingudActivationRecord => ({
      schemaVersion: 1,
      active,
      previous: null,
      activatedAt: '2026-10-01T00:00:00.000Z',
      snapshot: null,
      ...(appVersion ? { activeAppVersion: appVersion } : {})
    })
    const admitOn = async (
      record: KingudActivationRecord,
      options: { force?: boolean } = {}
    ): Promise<{ admitted: string | null; result: unknown }> => {
      vi.spyOn(getAppEnvironment(), 'getVersion').mockReturnValue('1.5.0')
      let admitted: string | null = null
      mocks.deploy.mockImplementationOnce(async (deployOptions: KingudDeployOptions) => {
        admitted = deployOptions.admitRecord?.(record, VERSION) ?? null
        return admitted
          ? {
              outcome: 'installed-not-activated',
              fullVersion: VERSION,
              code: KINGUD_ACTIVATION_POLICY_REFUSED_CODE,
              reason: admitted
            }
          : { outcome: 'installed-and-activated', fullVersion: VERSION }
      })
      const result = await createManagedKingudEnvironment(userDataPath, {
        name: 'Managed',
        sshTargetId: 'ssh-1',
        ...options
      })
      return { admitted, result }
    }

    it('redeploys a host an older build stopped without naming its version', async () => {
      // What every Stop that predates keeping the app version commits.
      const legacy = withDeactivatedVersion(servedBy('1.4.0', '0.1.0+old'))
      expect(legacy.activeAppVersion).toBeUndefined()
      const { admitted, result } = await admitOn(legacy)
      expect(admitted).toBeNull()
      expect(result).toMatchObject({ outcome: 'created', activeVersion: VERSION })
    })

    it('refuses an older build on a host a newer desktop stopped, naming both versions', async () => {
      const stopped = withDeactivatedVersionCommitted(servedBy('1.6.0', '0.1.0+new'))
      const { admitted, result } = await admitOn(stopped)
      expect(admitted).toContain('Kingu 1.6.0')
      expect(admitted).toContain('(1.5.0)')
      expect(result).toMatchObject({
        outcome: 'deferred',
        code: KINGUD_ACTIVATION_POLICY_REFUSED_CODE,
        forceable: true
      })
    })

    it('redeploys a host the same Kingu version stopped', async () => {
      const stopped = withDeactivatedVersionCommitted(servedBy('1.5.0', '0.1.0+other'))
      const { admitted, result } = await admitOn(stopped)
      expect(admitted).toBeNull()
      expect(result).toMatchObject({ outcome: 'created' })
    })

    it('restarts the stopped build itself even when a newer desktop stopped it', async () => {
      const stopped = withDeactivatedVersionCommitted(servedBy('1.6.0', VERSION))
      expect((await admitOn(stopped)).admitted).toBeNull()
    })

    it('runs this version anyway when the deploy is forced', async () => {
      const stopped = withDeactivatedVersionCommitted(servedBy('1.6.0', '0.1.0+new'))
      const { admitted, result } = await admitOn(stopped, { force: true })
      expect(admitted).toBeNull()
      expect(result).toMatchObject({ outcome: 'created' })
    })
  })

  describe('a host another Kingu version already serves', () => {
    const OTHER = '0.0.9+old111'
    let hostAppVersion = '9.9.9'
    const activeRecord = (active: string): KingudActivationRecord => ({
      schemaVersion: 1,
      active,
      previous: null,
      activatedAt: '2026-10-01T00:00:00.000Z',
      snapshot: null,
      activeAppVersion: hostAppVersion
    })
    beforeEach(() => {
      mocks.resolveContext.mockImplementation(async (claimed: SshTarget) => ({
        activationRecord: activeRecord(OTHER),
        serverTarget: 'linux-x64-glibc',
        connection: {},
        host: getRemoteHostPlatform('linux-x64'),
        remoteHome: '/home/dev',
        target: claimed,
        userDataDir: '/home/dev/.kingu'
      }))
      mocks.readRecord.mockImplementation(async () => activeRecord(OTHER))
      mocks.wake.mockResolvedValue({ outcome: 'serving' })
    })

    it.each(['9.9.9', '0.0.1'])(
      'pairs with a build Kingu %s runs, without uploading or restarting it',
      async (appVersion) => {
        vi.spyOn(getAppEnvironment(), 'getVersion').mockReturnValue('1.5.0')
        hostAppVersion = appVersion
        const result = await deploy()

        expect(mocks.deploy).not.toHaveBeenCalled()
        expect(mocks.probe).toHaveBeenCalledWith(
          expect.objectContaining({ remoteInstallDir: expect.stringContaining(OTHER) }),
          { buildHash: 'running-hash', fullVersion: OTHER }
        )
        expect(result).toMatchObject({ outcome: 'already-current', activeVersion: OTHER })
        const [environment] = listEnvironments(userDataPath)
        expect(environment?.kingudDeployment).toMatchObject({
          sshTargetId: 'ssh-1',
          localPort: 46_768
        })
      }
    )

    it('pairs a relay migration with the running build too, under its journaled fence', async () => {
      target = { ...target, kingudFence: { environmentId: 'env-m' }, generation: 9 }
      writeKingudMigrationSourceCutover(
        userDataPath,
        kingudMigrationCutoverFixture('m-1', 'ssh-1', { generation: 9, environmentId: 'env-m' })
      )
      const result = await createManagedKingudEnvironment(userDataPath, {
        name: 'Managed',
        sshTargetId: 'ssh-1',
        migration: true
      })

      // Its own deploy would wait on a terminal count only the paired server can give.
      expect(mocks.deploy).not.toHaveBeenCalled()
      expect(result).toMatchObject({ outcome: 'already-current', activeVersion: OTHER })
      expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual(['env-m'])
      expect(target.kingudProvisioning).toBeUndefined()
    })

    it('a relay migration onto a rebooted host starts the stopped build and pairs (#28833)', async () => {
      target = { ...target, kingudFence: { environmentId: 'env-m' }, generation: 9 }
      writeKingudMigrationSourceCutover(
        userDataPath,
        kingudMigrationCutoverFixture('m-1', 'ssh-1', { generation: 9, environmentId: 'env-m' })
      )
      mocks.wake.mockResolvedValueOnce({ outcome: 'started', readiness: readiness() })
      await expect(
        createManagedKingudEnvironment(userDataPath, {
          name: 'Managed',
          sshTargetId: 'ssh-1',
          migration: true
        })
      ).resolves.toMatchObject({ outcome: 'already-current', activeVersion: OTHER })
      expect(mocks.deploy).not.toHaveBeenCalled()
    })

    it('starts nothing for a migration whose running build is unverifiable', async () => {
      target = { ...target, kingudFence: { environmentId: 'env-m' }, generation: 9 }
      writeKingudMigrationSourceCutover(
        userDataPath,
        kingudMigrationCutoverFixture('m-1', 'ssh-1', { generation: 9, environmentId: 'env-m' })
      )
      mocks.wake.mockResolvedValueOnce({ outcome: 'unverifiable' })
      await expect(
        createManagedKingudEnvironment(userDataPath, {
          name: 'Managed',
          sshTargetId: 'ssh-1',
          migration: true
        })
      ).rejects.toThrow('process state is unverifiable')
      expect(mocks.deploy).not.toHaveBeenCalled()
      expect(listEnvironments(userDataPath)).toEqual([])
    })

    it('deploys its own build as before when forced', async () => {
      await createManagedKingudEnvironment(userDataPath, {
        name: 'Managed',
        sshTargetId: 'ssh-1',
        force: true
      })
      expect(mocks.wake).not.toHaveBeenCalled()
      expect(mocks.deploy).toHaveBeenCalledOnce()
    })

    it('keeps the deploy path for a host already on this build, waking it after', async () => {
      mocks.localVersion.mockReturnValue(OTHER)
      mocks.deploy.mockImplementationOnce(async () => {
        mocks.events.push('deploy')
        return { outcome: 'already-active', fullVersion: OTHER }
      })
      mocks.wake.mockImplementationOnce(async () => {
        mocks.events.push('wake')
        return { outcome: 'serving' }
      })
      mocks.probe.mockImplementation(async () => {
        mocks.events.push('probe')
        return readiness()
      })
      await expect(deploy()).resolves.toMatchObject({ outcome: 'already-current' })
      expect(mocks.events.filter((event) => event !== 'flush' && event !== 'connect')).toEqual([
        'deploy',
        'wake',
        'probe'
      ])
    })

    it('a host this build ran, rebooted or killed since, starts it and registers (#27284)', async () => {
      mocks.localVersion.mockReturnValue(OTHER)
      mocks.deploy.mockResolvedValueOnce({ outcome: 'already-active', fullVersion: OTHER })
      mocks.wake.mockResolvedValueOnce({ outcome: 'started', readiness: readiness() })
      await expect(deploy()).resolves.toMatchObject({
        outcome: 'already-current',
        activeVersion: OTHER
      })
      expect(mocks.wake.mock.calls[0]?.[0]).toMatchObject({ port: 6_768, remoteHome: '/home/dev' })
      expect(listEnvironments(userDataPath)).toHaveLength(1)
    })

    it('starts nothing over an unverifiable slot on this build, and registers nothing', async () => {
      mocks.localVersion.mockReturnValue(OTHER)
      mocks.deploy.mockResolvedValueOnce({ outcome: 'already-active', fullVersion: OTHER })
      mocks.wake.mockResolvedValueOnce({ outcome: 'unverifiable' })
      mocks.probe.mockRejectedValueOnce(new Error('kingud process state is unverifiable.'))
      await expect(deploy()).rejects.toThrow('unverifiable')
      expect(listEnvironments(userDataPath)).toEqual([])
    })

    it('surfaces an abandoned update the wake could not recover on this build', async () => {
      mocks.localVersion.mockReturnValue(OTHER)
      mocks.deploy.mockResolvedValueOnce({ outcome: 'already-active', fullVersion: OTHER })
      mocks.wake.mockResolvedValueOnce({ outcome: 'recovery-refused', reason: 'needs Recover' })
      await expect(deploy()).rejects.toThrow('needs Recover')
      expect(mocks.probe).not.toHaveBeenCalled()
      expect(listEnvironments(userDataPath)).toEqual([])
    })

    it('pairs with a build a rebooted host stopped, after starting it (#28833)', async () => {
      // A reboot leaves the record naming a slot whose process is gone; only a started server
      // can count terminals, so the update check after pairing decides the update, not a guess.
      mocks.wake.mockResolvedValueOnce({ outcome: 'started', readiness: readiness() })
      const result = await deploy()
      expect(mocks.deploy).not.toHaveBeenCalled()
      expect(result).toMatchObject({ outcome: 'already-current', activeVersion: OTHER })
    })

    it('after a reboot, waits on the desktop starting the server, then pairs on reconnect (#28833)', async () => {
      // Every desktop reconnects at once; the one that loses the race to start the stopped server
      // used to deploy its own build, which over an uncounted host could only defer on the census.
      mocks.deploy.mockResolvedValue({
        outcome: 'installed-not-activated',
        fullVersion: VERSION,
        code: 'kingud_update_terminal_census_unavailable',
        reason: 'The terminal daemon did not answer a session count'
      })
      mocks.wake.mockResolvedValueOnce({ outcome: 'fenced' })
      mocks.fenceRefusal.mockResolvedValueOnce({
        code: 'kingud_activation_fence_busy',
        reason: 'Another run is changing this host’s managed server.'
      })
      await expect(deploy()).resolves.toMatchObject({
        outcome: 'deferred',
        code: 'kingud_activation_fence_busy',
        forceable: false
      })
      expect(mocks.deploy).not.toHaveBeenCalled()
      expect(listEnvironments(userDataPath)).toEqual([])

      mocks.wake.mockResolvedValueOnce({ outcome: 'serving' })
      await expect(deploy()).resolves.toMatchObject({
        outcome: 'already-current',
        activeVersion: OTHER
      })
      expect(mocks.deploy).not.toHaveBeenCalled()
      expect(listEnvironments(userDataPath)).toHaveLength(1)
    })

    it('counts terminals against the record a stop by another desktop left, not the stale one', async () => {
      mocks.wake.mockResolvedValueOnce({ outcome: 'not-activated' })
      const stopped = withDeactivatedVersion(activeRecord(OTHER))
      mocks.readRecord.mockResolvedValue(stopped)
      await deploy()
      const options: KingudDeployOptions | undefined = mocks.deploy.mock.calls[0]?.[0]
      expect(options?.censusRecord).toEqual(stopped)
      expect(options?.census.liveSessions).toBe(0)
    })

    it('registers nothing and stops nothing when the running build is unverifiable', async () => {
      mocks.wake.mockResolvedValueOnce({ outcome: 'unverifiable' })
      await expect(deploy()).rejects.toThrow('process state is unverifiable')
      expect(mocks.deploy).not.toHaveBeenCalled()
      expect(listEnvironments(userDataPath)).toEqual([])
    })
  })

  it('refuses a host with direct SSH projects before claiming or connecting', async () => {
    setupStore({ repos: [{ connectionId: 'ssh-1' }] })
    await expect(deploy()).rejects.toThrow('repositories or folder workspaces')
    expect(target.kingudFence).toBeUndefined()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('refuses a host that saved state still references, naming it, before claiming', async () => {
    const leases = [{ ptyId: 'pty-1', state: 'expired' }]
    const store = {
      ...emptyDependentStateStore({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census reads only ptyId and state.
        getSshRemotePtyLeases: () => leases as never
      }),
      allocateSshTargetGeneration: () => 9,
      flushPendingOrThrowAsync: async () => {},
      getFolderWorkspaces: () => [],
      getRepos: () => [],
      getSshTarget: () => target,
      getSshTargets: () => [target],
      updateSshTarget: (_id: string, updates: Partial<SshTarget>) =>
        (target = { ...target, ...updates })
    }
    mocks.state.store = {
      getTarget: () => target,
      getKingudRuntimeClaims: () => new SshTargetKingudClaims(store)
    }
    await expect(deploy()).rejects.toThrow('terminal-lease ×1 (pty-1 (expired))')
    expect(target.kingudFence).toBeUndefined()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('refuses a taken server name', async () => {
    await deploy()
    target = { ...target, id: 'ssh-2', kingudFence: undefined }
    await expect(
      createManagedKingudEnvironment(userDataPath, { name: 'Managed', sshTargetId: 'ssh-2' })
    ).rejects.toThrow('already exists')
  })

  it('does not contact the host when the claim cannot be made durable', async () => {
    const claims = new SshTargetKingudClaims({
      allocateSshTargetGeneration: () => 9,
      flushPendingOrThrowAsync: async () => {
        throw new Error('disk full')
      },
      getFolderWorkspaces: () => [],
      getRepos: () => [],
      ...emptyDependentStateStore(),
      getSshTarget: () => target,
      getSshTargets: () => [target],
      updateSshTarget: (_id, updates) => (target = { ...target, ...updates })
    })
    mocks.state.store = { getTarget: () => target, getKingudRuntimeClaims: () => claims }
    await expect(deploy()).rejects.toThrow('disk full')
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('returns a deferral, keeps the claim and closes nothing it did not open', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: VERSION,
      code: 'kingud_update_terminal_census_unavailable',
      reason: 'unknown census'
    })
    await expect(deploy()).resolves.toMatchObject({ outcome: 'deferred', forceable: false })
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(getManagedKingudFenceEnvironmentId(target)).not.toBeNull()
    expect(mocks.startTunnel).not.toHaveBeenCalled()
  })

  it('resumes an interrupted deploy under the environment id its claim recorded', async () => {
    mocks.probe.mockRejectedValueOnce(new Error('readiness unverifiable'))
    await expect(deploy()).rejects.toThrow('readiness unverifiable')
    const claimedId = getManagedKingudFenceEnvironmentId(target)
    expect(claimedId).not.toBeNull()
    mocks.deploy.mockResolvedValueOnce({ outcome: 'already-active', fullVersion: VERSION })
    const result = await deploy()
    expect(result).toMatchObject({ outcome: 'already-current' })
    expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual([claimedId])
  })

  it('closes the tunnel it opened when registration fails', async () => {
    mocks.probe.mockResolvedValueOnce({
      ...readiness(),
      pairing: { available: false, guidance: 'off' }
    })
    mocks.startTunnel.mockResolvedValueOnce(46_768)
    await expect(deploy()).rejects.toThrow('did not publish a pairing offer')
    expect(mocks.closeTunnel).toHaveBeenCalledOnce()
    expect(JSON.stringify(mocks.closeTunnel.mock.calls)).not.toContain('device-token')
  })

  it('finishes an already registered server by ensuring its tunnel, without redeploying', async () => {
    await deploy()
    mocks.resolveContext.mockImplementation(async (claimed: SshTarget) => ({
      activationRecord: { ...emptyRecord, active: VERSION },
      serverTarget: 'linux-x64-glibc',
      connection: {},
      host: getRemoteHostPlatform('linux-x64'),
      remoteHome: '/home/dev',
      target: claimed,
      userDataDir: '/home/dev/.kingu'
    }))
    await expect(deploy()).resolves.toMatchObject({ outcome: 'already-current' })
    expect(mocks.deploy).toHaveBeenCalledOnce()
    expect(mocks.ensureTunnel).toHaveBeenCalledOnce()
  })

  it('stops at an interrupted activation the host cannot reconcile yet', async () => {
    mocks.recover.mockResolvedValueOnce({
      outcome: 'pending',
      code: 'fresh',
      reason: 'still fresh'
    })
    await expect(deploy()).rejects.toThrow('still fresh')
    expect(mocks.deploy).not.toHaveBeenCalled()
  })
})

describe('createManagedKingudEnvironment for a migration', () => {
  it('deploys into its own journaled fence without leaving a provisioning intent', async () => {
    target = { ...target, kingudFence: { environmentId: 'env-m' }, generation: 9 }
    writeKingudMigrationSourceCutover(
      userDataPath,
      kingudMigrationCutoverFixture('m-1', 'ssh-1', { generation: 9, environmentId: 'env-m' })
    )
    await expect(
      createManagedKingudEnvironment(userDataPath, {
        name: 'Managed',
        sshTargetId: 'ssh-1',
        migration: true
      })
    ).resolves.toMatchObject({ outcome: 'created' })
    expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual(['env-m'])
    expect(target.kingudProvisioning).toBeUndefined()
  })

  it('refuses a migration deploy whose fence has no journal, before connecting', async () => {
    target = { ...target, kingudFence: { environmentId: 'env-m' }, generation: 9 }
    await expect(
      createManagedKingudEnvironment(userDataPath, {
        name: 'Managed',
        sshTargetId: 'ssh-1',
        migration: true
      })
    ).rejects.toThrow('kingud_migration_fence_required')
    expect(mocks.connect).not.toHaveBeenCalled()
  })
})

describe('getManagedKingudRuntimeStatus', () => {
  it('reports the activation record and an interrupted transaction without repairing it', async () => {
    await deploy()
    const [environment] = listEnvironments(userDataPath)
    mocks.resolveContext.mockImplementation(async (claimed: SshTarget) => ({
      activationRecord: { ...emptyRecord, active: VERSION, activatedAt: 'now' },
      connection: {},
      host: getRemoteHostPlatform('linux-x64'),
      remoteHome: '/home/dev',
      target: claimed
    }))
    mocks.readTransaction.mockResolvedValueOnce({
      operation: 'activate',
      phase: 'candidate-ready',
      candidateVersion: '0.2.0+def',
      startedAt: 'then'
    })
    await expect(getManagedKingudRuntimeStatus(userDataPath, 'Managed')).resolves.toEqual({
      environmentId: environment?.id,
      sshTargetId: 'ssh-1',
      activeVersion: VERSION,
      previousVersion: null,
      activatedAt: 'now',
      rollbackAvailable: false,
      recovery: {
        operation: 'activate',
        phase: 'candidate-ready',
        version: '0.2.0+def',
        startedAt: 'then'
      },
      terminals: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 39 },
      migration: null,
      deferredUpdate: null
    })
    expect(mocks.recover).toHaveBeenCalledTimes(1)
  })

  it('reports an interrupted decommission without finishing it', async () => {
    await deploy()
    mocks.readTransaction.mockResolvedValueOnce({
      operation: 'decommission',
      phase: 'stop-dispatched',
      activeVersion: VERSION,
      startedAt: 'then'
    })
    await expect(getManagedKingudRuntimeStatus(userDataPath, 'Managed')).resolves.toMatchObject({
      recovery: { operation: 'decommission', phase: 'stop-dispatched', version: VERSION }
    })
  })

  it('reports an unfinished migration into the server', async () => {
    await deploy()
    const [environment] = listEnvironments(userDataPath)
    writeKingudMigrationSourceCutover(userDataPath, {
      ...kingudMigrationCutoverFixture('m-2', 'ssh-1', {
        generation: 9,
        environmentId: environment!.id
      }),
      phase: 'destination-staged'
    })
    mocks.resolveContext.mockImplementation(async (claimed: SshTarget) => ({
      activationRecord: { ...emptyRecord, active: VERSION },
      connection: {},
      host: getRemoteHostPlatform('linux-x64'),
      remoteHome: '/home/dev',
      target: claimed
    }))
    await expect(getManagedKingudRuntimeStatus(userDataPath, 'Managed')).resolves.toMatchObject({
      migration: { migrationId: 'm-2', phase: 'destination-staged' }
    })
  })

  it('refuses a server whose SSH registration was re-created', async () => {
    await deploy()
    target = { ...target, generation: 10 }
    await expect(getManagedKingudRuntimeStatus(userDataPath, 'Managed')).rejects.toThrow(
      'no longer valid'
    )
  })
})
