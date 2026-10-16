import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  emptyKingudActivationRecord,
  type KingudActivationRecord
} from '../ssh/kingud-activation-record'
import type { KingudSlotOptions } from '../ssh/kingud-recovery-slot'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'

type FakeHost = {
  lock: string | null
  alive: Set<number>
  pidFiles: Map<string, number>
  record: unknown
  transaction: unknown
  stopTarget: unknown
  readinessBuildHash: string
  slotBuildHash: string
  commands: string[]
  writes: unknown[]
  fenced: boolean
}

const host = vi.hoisted((): FakeHost => ({
  lock: null,
  alive: new Set(),
  pidFiles: new Map(),
  record: null,
  transaction: null,
  stopTarget: null,
  readinessBuildHash: 'abcdefabcdefabcd',
  slotBuildHash: 'abcdefabcdefabcd',
  commands: [],
  writes: [],
  fenced: false
}))

vi.mock('../ssh/kingud-remote-record-file', () => ({
  readBoundedKingudRemoteRecord: async () =>
    host.lock === null ? { state: 'absent' } : { state: 'present', raw: host.lock }
}))
vi.mock('../ssh/kingud-remote-runtime-control', () => ({
  execKingudRemote: async (_slot: unknown, command: string) => {
    host.commands.push(command)
    const kill = /kill -0 (\d+)/.exec(command)
    if (kill) {
      return host.alive.has(Number(kill[1])) ? 'LIVE\n' : 'DEAD\n'
    }
    const cat = /^cat '([^']+)'/.exec(command)
    if (cat) {
      return `${host.pidFiles.get(cat[1]) ?? ''}\n`
    }
    if (command.startsWith('head -c')) {
      return `${JSON.stringify({
        type: 'kingu_server_ready',
        runtimeId: 'r1',
        health: { buildHash: host.readinessBuildHash, buildVersion: '0.1.0' }
      })}\n`
    }
    return ''
  }
}))
vi.mock('../ssh/kingud-managed-remote-stop', () => ({
  readRemoteKingudManagedStopTarget: async () => host.stopTarget
}))
vi.mock('../ssh/kingud-recovery-slot', () => ({
  kingudSlotDir: (_slot: unknown, version: string) => `/home/u/.kingu-remote/kingud-${version}`,
  resolveKingudSlotIdentity: async (_slot: unknown, version: string) => ({
    version,
    remoteDir: `/home/u/.kingu-remote/kingud-${version}`,
    buildHash: host.slotBuildHash
  })
}))
vi.mock('../ssh/kingud-activation-gate', () => ({
  evaluateKingudActivation: (
    readiness: { health?: { buildHash?: string } } | null,
    expected: { buildHash: string }
  ) =>
    readiness?.health?.buildHash === expected.buildHash
      ? { decision: 'accept' }
      : { decision: 'reject', reason: 'its build does not match the installed slot.' }
}))
vi.mock('../ssh/kingud-activation-record-store', () => ({
  readKingudActivationRecord: async () => host.record,
  writeKingudActivationRecord: async (_slot: unknown, record: unknown) => {
    host.writes.push(record)
  }
}))
vi.mock('../ssh/kingud-activation-transaction-store', () => ({
  readKingudActivationTransaction: async () => host.transaction
}))
vi.mock('../ssh/kingud-activation-lock', () => ({
  withKingudActivationLock: async (
    _slot: unknown,
    run: () => Promise<unknown>,
    held: () => unknown
  ) => {
    if (host.fenced) {
      return held()
    }
    return run()
  }
}))

import { adoptUnrecordedWslKingud } from './wsl-kingud-instance-adoption'

const OLD = '0.1.0+aaaaaaaaaaaa'
const NEW = '0.2.0+bbbbbbbbbbbb'
const slot: KingudSlotOptions = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every host call is mocked at its module.
  conn: {} as KingudSlotOptions['conn'],
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/u',
  nodePath: '',
  userDataDir: '/home/u/.kingu',
  bindHost: '127.0.0.1',
  port: 6768
}
const NOW = new Date('2026-10-12T01:00:00.000Z')

function lockFor(pid: number, version: string): string {
  return JSON.stringify({
    pid,
    startedAtMs: 1,
    identity: '1000',
    version,
    acquiredAt: '2026-10-11T00:00:00.000Z',
    nonce: 'n1',
    role: 'kingud'
  })
}

function stopTargetFor(pid: number, version: string) {
  return {
    state: 'ready',
    context: {
      version,
      runtimeId: 'r1',
      instance: { pid, startedAtMs: 1, nonce: 'n1', lockPath: '/home/u/.kingu/kingud.lock' }
    }
  }
}

function record(overrides: Partial<KingudActivationRecord> = {}): KingudActivationRecord {
  return { ...emptyKingudActivationRecord(), ...overrides }
}

function adopt(current: KingudActivationRecord) {
  host.record = current
  return adoptUnrecordedWslKingud(slot, current, () => NOW)
}

describe('adopting an kingud the activation record does not name', () => {
  beforeEach(() => {
    host.lock = null
    host.alive.clear()
    host.pidFiles.clear()
    host.transaction = null
    host.stopTarget = null
    host.readinessBuildHash = 'abcdefabcdefabcd'
    host.slotBuildHash = 'abcdefabcdefabcd'
    host.commands.length = 0
    host.writes.length = 0
    host.fenced = false
  })

  it('adopts a stale kingud a removed registration left running, never stopping it', async () => {
    host.lock = lockFor(500, OLD)
    host.alive.add(500)
    host.stopTarget = stopTargetFor(500, OLD)
    // The failed Remove left nothing active in the record.
    const result = await adopt(record({ previous: OLD }))
    expect(result).toMatchObject({ outcome: 'adopted', version: OLD, pid: 500 })
    expect(host.writes).toEqual([
      record({ active: OLD, previous: OLD, activatedAt: NOW.toISOString(), snapshot: null })
    ])
    expect(host.commands).toContain(
      `(umask 077 && printf '%s\\n' 500 > '/home/u/.kingu-remote/kingud-${OLD}/.kingud-pid')`
    )
    expect(host.commands.some((command) => /\bkill\b(?! -0)/.test(command))).toBe(false)
  })

  it('records an kingud from a different version as active, keeping the recorded one as previous', async () => {
    host.lock = lockFor(600, OLD)
    host.alive.add(600)
    host.stopTarget = stopTargetFor(600, OLD)
    const result = await adopt(
      record({ active: NEW, activeAppVersion: '1.5.0', activatedAt: '2026-10-10T00:00:00.000Z' })
    )
    expect(result).toMatchObject({ outcome: 'adopted', version: OLD, pid: 600 })
    expect(host.writes).toEqual([
      record({
        active: OLD,
        previous: NEW,
        previousAppVersion: '1.5.0',
        activatedAt: NOW.toISOString(),
        snapshot: null
      })
    ])
  })

  it('repoints only the pid file when the recorded slot is serving under another pid', async () => {
    host.lock = lockFor(700, OLD)
    host.alive.add(700)
    host.pidFiles.set(`/home/u/.kingu-remote/kingud-${OLD}/.kingud-pid`, 699)
    host.stopTarget = stopTargetFor(700, OLD)
    const current = record({ active: OLD })
    await expect(adopt(current)).resolves.toMatchObject({ outcome: 'adopted', record: current })
    expect(host.writes).toEqual([])
    expect(host.commands.some((command) => command.includes("printf '%s\\n' 700"))).toBe(true)
  })

  it('leaves the recorded instance, a dead lock holder and a desktop lock alone', async () => {
    host.lock = lockFor(800, OLD)
    host.alive.add(800)
    host.pidFiles.set(`/home/u/.kingu-remote/kingud-${OLD}/.kingud-pid`, 800)
    await expect(adopt(record({ active: OLD }))).resolves.toEqual({ outcome: 'none' })
    host.alive.clear()
    await expect(adopt(record())).resolves.toEqual({ outcome: 'none' })
    host.lock = JSON.stringify({ ...JSON.parse(lockFor(800, OLD)), role: 'desktop' })
    host.alive.add(800)
    await expect(adopt(record())).resolves.toEqual({ outcome: 'none' })
    expect(host.writes).toEqual([])
  })

  it('refuses, writing nothing, when the running kingud cannot be proven to be its slot', async () => {
    host.lock = lockFor(900, OLD)
    host.alive.add(900)
    host.stopTarget = {
      state: 'refused',
      verdict: 'unverifiable',
      code: 'kingud_managed_stop_instance_unverifiable',
      reason: 'The instance lock does not name the kingud that published readiness.'
    }
    await expect(adopt(record())).rejects.toMatchObject({
      name: 'WslKingudUnrecordedInstanceError',
      message: expect.stringContaining('cannot be identified')
    })
    host.stopTarget = stopTargetFor(900, OLD)
    host.readinessBuildHash = '0000000000000000'
    await expect(adopt(record())).rejects.toThrow(/does not match the installed slot/)
    expect(host.writes).toEqual([])
  })

  it('refuses under a busy fence, a pending journal or a record that changed', async () => {
    host.lock = lockFor(910, OLD)
    host.alive.add(910)
    host.stopTarget = stopTargetFor(910, OLD)
    host.fenced = true
    await expect(adopt(record())).rejects.toThrow(/Another Kingu is changing/)
    host.fenced = false
    host.transaction = { transactionId: 't1' }
    await expect(adopt(record())).rejects.toThrow(/interrupted activation is pending/)
    host.transaction = null
    host.record = record({ active: NEW })
    await expect(adoptUnrecordedWslKingud(slot, record(), () => NOW)).rejects.toThrow(
      /record changed/
    )
    expect(host.writes).toEqual([])
  })
})
