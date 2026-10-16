import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from './ssh-relay-exec-command'
import type * as RecordFile from './kingud-remote-record-file'
import type * as InstallLock from './ssh-relay-install-lock'

vi.mock('./ssh-relay-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
vi.mock('./ssh-connection-utils', () => ({ shellEscape: (s: string) => `'${s}'` }))
vi.mock('./ssh-relay-install-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof InstallLock>()),
  acquireInstallLock: vi.fn()
}))
vi.mock('./kingud-remote-record-file', async (importOriginal) => ({
  ...(await importOriginal<typeof RecordFile>()),
  writeAtomicKingudRemoteRecord: vi.fn()
}))

import { execCommand } from './ssh-relay-exec-command'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { writeAtomicKingudRemoteRecord } from './kingud-remote-record-file'
import { decommissionRemoteKingud } from './kingud-remote-decommission'
import { recoverInterruptedKingudActivation } from './kingud-activation-recovery'
import { parseKingudActivationRecord } from './kingud-activation-record'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { KingudTerminalCensus } from '../../shared/kingud-terminal-census'
import { FakeKingudHost, OLD, type CrashMode } from './kingud-activation-host-test-harness'

let host = new FakeKingudHost()

const slot = {
  conn: Object.create(null),
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/u',
  nodePath: '/usr/bin/node',
  userDataDir: '/home/u/.kingu',
  bindHost: '127.0.0.1',
  port: 7777,
  readinessTimeoutMs: 50,
  sleep: async () => {},
  now: () => new Date('2026-02-02T00:00:00.000Z')
}
const idle: KingudTerminalCensus = {
  liveSessions: 0,
  startedSinceActivation: 0,
  daemonProtocolVersion: 3
}

function currentRecord() {
  const parsed = parseKingudActivationRecord(host.record)
  if (parsed.state !== 'ok') {
    throw new Error('fixture record is unreadable')
  }
  return parsed.record
}

const decommission = (census: KingudTerminalCensus = idle) =>
  decommissionRemoteKingud({ ...slot, record: currentRecord(), census })

beforeEach(() => {
  vi.clearAllMocks()
  host = FakeKingudHost.deployedOld()
  vi.mocked(execCommand).mockImplementation(async (_conn, command) => host.exec(command))
  vi.mocked(acquireInstallLock).mockImplementation(async (_conn, _root, _host, options) => {
    host.acquireFence(options)
  })
  vi.mocked(writeAtomicKingudRemoteRecord).mockImplementation(async (_target, path, contents) =>
    host.write(path, contents)
  )
})

function expectExactlyTheRecordedSlot(): void {
  const active = host.activeVersion()
  expect([...host.alive]).toEqual(active ? [active] : [])
  expect(host.journal).toBeNull()
  expect(host.fence).toBe(false)
}

describe('decommissioning a managed kingud', () => {
  it('stops the active instance by request, then records that nothing serves', async () => {
    expect(await decommission()).toEqual({
      outcome: 'decommissioned',
      version: OLD,
      retirement: 'retired'
    })
    expect(currentRecord()).toMatchObject({ active: null, previous: OLD, snapshot: null })
    expectExactlyTheRecordedSlot()
    // Never a signal: the instance-bound request is the only stop path.
    expect(host.commands.some((command) => command.includes('kill -TERM'))).toBe(false)
  })

  it.each([
    [{ ...idle, liveSessions: null }, 'unverifiable', 'kingud_decommission_census_unavailable'],
    [{ ...idle, liveSessions: 2 }, 'live', 'kingud_decommission_terminals_running']
  ] as const)('refuses while the census says %j', async (census, verdict, code) => {
    expect(await decommission(census)).toMatchObject({ outcome: 'refused', verdict, code })
    expect(host.alive.has(OLD)).toBe(true)
    expect(writeAtomicKingudRemoteRecord).not.toHaveBeenCalled()
  })

  it('refuses an kingud that cannot be addressed by request', async () => {
    host.alive.clear()
    expect(await decommission()).toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'kingud_managed_stop_readiness_unverifiable'
    })
    expect(writeAtomicKingudRemoteRecord).not.toHaveBeenCalled()
  })

  it('withdraws a request kingud never acted on and keeps serving', async () => {
    host.managedStop = 'stays'
    expect(await decommission()).toMatchObject({
      outcome: 'refused',
      verdict: 'live',
      code: 'kingud_decommission_stop_withdrawn'
    })
    expect(currentRecord().active).toBe(OLD)
    expectExactlyTheRecordedSlot()
  })

  it('keeps the fence while kingud is still stopping, and recovery finishes once it exits', async () => {
    host.managedStop = 'stays-dispatched'
    expect(await decommission()).toMatchObject({
      outcome: 'refused',
      verdict: 'live',
      code: 'kingud_decommission_stop_unsettled'
    })
    expect(host.fence).toBe(true)
    expect(host.journal).not.toBeNull()
    expect(await recoverInterruptedKingudActivation(slot)).toMatchObject({
      outcome: 'refused',
      code: 'kingud_recovery_decommission_unsettled'
    })
    host.managedStop = 'exits'
    expect(await recoverInterruptedKingudActivation(slot)).toMatchObject({
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion: null
    })
    expectExactlyTheRecordedSlot()
  })

  it.each<CrashMode>(['before', 'after'])(
    'recovers to exactly the recorded slot when interrupted at every mutation (%s)',
    async (mode) => {
      host = FakeKingudHost.deployedOld()
      await decommission()
      const total = host.mutations
      expect(total).toBeGreaterThan(3)
      for (let crashAt = 1; crashAt <= total; crashAt += 1) {
        host = FakeKingudHost.deployedOld()
        host.crashAt = crashAt
        host.crashMode = mode
        await decommission().catch(() => undefined)
        host.crashAt = null
        const result = await recoverInterruptedKingudActivation(slot)
        expect(['recovered', 'none'], `mutation ${crashAt}`).toContain(result.outcome)
        expectExactlyTheRecordedSlot()
      }
    }
  )
})
