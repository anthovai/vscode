import type * as ExecCommandModule from './ssh-relay-exec-command'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
vi.mock('./ssh-connection-utils', () => ({ shellEscape: (s: string) => `'${s}'` }))
vi.mock('./ssh-relay-gc-claim', () => ({
  isRelayGcClaimOwned: vi.fn().mockResolvedValue(true),
  releaseRelayGcClaimWithRetry: vi.fn().mockResolvedValue('released'),
  tryAcquireRelayGcClaim: vi.fn().mockResolvedValue('token')
}))
vi.mock('./remote-install-gc-tombstone', () => ({
  cleanupRemoteInstallGcTombstones: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./ssh-relay-install-lock', () => ({
  RELAY_INSTALL_LOCK_NAME: '.install-lock',
  INSTALL_LOCK_STALE_MS: 20 * 60_000,
  INSTALL_LOCK_STALE_SECONDS: 20 * 60,
  isRelayInstallLockStale: vi.fn().mockResolvedValue(false)
}))

import { execCommand } from './ssh-relay-exec-command'
import { gcOldKingudVersions } from './kingud-remote-gc'
import { emptyKingudActivationRecord } from './kingud-activation-record'
import { serializeKingudActivationTransaction } from './kingud-activation-transaction'
import { createKingudActivationTransaction } from './kingud-activation-transaction-transitions'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { KingudHostTransport } from './kingud-host-transport'

const conn: KingudHostTransport = Object.create(null)
const host = getRemoteHostPlatform('linux-x64')
const mockExec = vi.mocked(execCommand)

/**
 * Drive one GC pass against a scripted host. `listing` is what the remote listing command
 * returns; every other command answers from `responses`, defaulting to the happy path
 * (unlocked, complete, dead) so a candidate is removed unless a test says otherwise.
 */
function scriptHost(options: {
  listing: string[]
  liveness?: Record<string, 'LIVE' | 'DEAD' | 'UNKNOWN' | Error>
  removed: string[]
  /** The activation journal: absent by default, raw contents, or a read with no answer. */
  journal?: string | Error
  fenceHeld?: boolean
}): void {
  mockExec.mockImplementation(async (_conn, command: string) => {
    if (command.includes('__KINGUD_RECORD_PRESENT__') && command.includes('transaction.json')) {
      if (options.journal instanceof Error) {
        throw options.journal
      }
      return options.journal === undefined
        ? '__KINGUD_RECORD_ABSENT__\n'
        : `__KINGUD_RECORD_PRESENT__\n${options.journal}`
    }
    if (command.includes('.kingud-activation-transaction') && command.includes('LOCKED')) {
      return options.fenceHeld ? 'LOCKED' : 'OPEN'
    }
    if (command.includes('-mindepth 1 -maxdepth 1')) {
      return options.listing.join('\n')
    }
    if (command.includes('.install-lock')) {
      return 'OPEN'
    }
    if (command.includes('.store-lock') && command.includes('mkdir')) {
      return 'OK'
    }
    if (command.includes('.install-complete')) {
      return 'COMPLETE'
    }
    if (command.includes('.kingud-pid')) {
      const dir = Object.keys(options.liveness ?? {}).find((name) => command.includes(name))
      const result = dir ? (options.liveness?.[dir] ?? 'DEAD') : 'DEAD'
      if (result instanceof Error) {
        throw result
      }
      return result
    }
    if (command.startsWith('mv ')) {
      const match = command.match(/'([^']*)'/)
      if (match) {
        options.removed.push(match[1].split('/').pop() ?? '')
      }
      return 'MOVED'
    }
    return ''
  })
}

describe('kingud GC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('scopes its remote listing to the kingud namespace', async () => {
    const removed: string[] = []
    scriptHost({ listing: [], removed })
    await gcOldKingudVersions({
      conn,
      host,
      remoteHome: '/home/u',
      currentDirAbsPath: '/home/u/.kingu-remote/kingud-0.2.0+bb',
      record: emptyKingudActivationRecord()
    })
    const listCommand = mockExec.mock.calls
      .map((call) => String(call[1]))
      .find((c) => c.includes('find'))
    expect(listCommand).toContain("-name 'kingud-*'")
    expect(listCommand).not.toContain("-name 'relay-*'")
  })

  it('leaves relay directories alone even when the host hands them to it', async () => {
    // The host is lying — or a future listing bug widened the glob. GC must still refuse.
    const removed: string[] = []
    scriptHost({
      listing: ['relay-0.1.0+aa', 'relay-0.0.9+ff', 'kingud-0.1.0+aa'],
      removed
    })
    await gcOldKingudVersions({
      conn,
      host,
      remoteHome: '/home/u',
      currentDirAbsPath: '/home/u/.kingu-remote/kingud-0.2.0+bb',
      record: emptyKingudActivationRecord()
    })
    expect(removed).toEqual(['kingud-0.1.0+aa'])
  })

  it('never removes the active or the previous version', async () => {
    const removed: string[] = []
    scriptHost({
      listing: ['kingud-0.1.0+01d', 'kingud-0.2.0+9ee0', 'kingud-0.3.0+cc0'],
      removed
    })
    await gcOldKingudVersions({
      conn,
      host,
      remoteHome: '/home/u',
      currentDirAbsPath: '/home/u/.kingu-remote/kingud-0.3.0+cc0',
      record: {
        ...emptyKingudActivationRecord(),
        active: '0.3.0+cc0',
        previous: '0.2.0+9ee0'
      }
    })
    expect(removed).toEqual(['kingud-0.1.0+01d'])
  })

  it('never removes the version a live daemon was forked from', async () => {
    const removed: string[] = []
    scriptHost({ listing: ['kingud-0.1.0+01d', 'kingud-0.0.9+01de'], removed })
    await gcOldKingudVersions({
      conn,
      host,
      remoteHome: '/home/u',
      currentDirAbsPath: '/home/u/.kingu-remote/kingud-0.3.0+cc0',
      record: { ...emptyKingudActivationRecord(), active: '0.3.0+cc0' },
      liveDaemonVersion: '0.1.0+01d'
    })
    expect(removed).toEqual(['kingud-0.0.9+01de'])
  })

  it('treats an unanswerable liveness probe as in use', async () => {
    const removed: string[] = []
    scriptHost({
      listing: ['kingud-0.1.0+bb0', 'kingud-0.0.9+dead'],
      liveness: { 'kingud-0.1.0+bb0': 'UNKNOWN', 'kingud-0.0.9+dead': 'DEAD' },
      removed
    })
    await gcOldKingudVersions({
      conn,
      host,
      remoteHome: '/home/u',
      currentDirAbsPath: '/home/u/.kingu-remote/kingud-0.3.0+cc0',
      record: emptyKingudActivationRecord()
    })
    expect(removed).toEqual(['kingud-0.0.9+dead'])
  })

  it('stops before later versions when liveness probe termination is unconfirmed', async () => {
    const removed: string[] = []
    const error = Object.assign(new Error('Liveness probe termination is unconfirmed'), {
      sshChannelCloseConfirmed: false
    })
    scriptHost({
      listing: ['kingud-0.1.0+bb0', 'kingud-0.0.9+dead'],
      liveness: { 'kingud-0.1.0+bb0': error },
      removed
    })

    await expect(
      gcOldKingudVersions({
        conn,
        host,
        remoteHome: '/home/u',
        currentDirAbsPath: '/home/u/.kingu-remote/kingud-0.3.0+cc0',
        record: emptyKingudActivationRecord()
      })
    ).rejects.toBe(error)

    expect(removed).toEqual([])
    // Journal read and fence probe, then the GC pass up to the unconfirmed probe.
    expect(mockExec).toHaveBeenCalledTimes(6)
    expect(mockExec.mock.calls.at(-1)?.[1]).toContain('.kingud-pid')
  })

  it('keeps a version after an ordinary probe failure and checks later versions', async () => {
    const removed: string[] = []
    scriptHost({
      listing: ['kingud-0.1.0+bb0', 'kingud-0.0.9+dead'],
      liveness: { 'kingud-0.1.0+bb0': new Error('Probe failed') },
      removed
    })

    await gcOldKingudVersions({
      conn,
      host,
      remoteHome: '/home/u',
      currentDirAbsPath: '/home/u/.kingu-remote/kingud-0.3.0+cc0',
      record: emptyKingudActivationRecord()
    })

    expect(removed).toEqual(['kingud-0.0.9+dead'])
  })

  it('collects the runtime store only when the caller names its runtime pins', async () => {
    const removed: string[] = []
    scriptHost({ listing: [], removed })
    const options = {
      conn,
      host,
      remoteHome: '/home/u',
      currentDirAbsPath: '/home/u/.kingu-remote/kingud-0.2.0+bb',
      record: emptyKingudActivationRecord()
    }
    const inventories = (): number =>
      mockExec.mock.calls.filter(([, command]) => String(command).includes('RUNTIME_STORE')).length

    await gcOldKingudVersions(options)
    expect(inventories()).toBe(0)

    await gcOldKingudVersions({ ...options, nodeRuntimePins: ['a'.repeat(64)] })
    expect(inventories()).toBe(1)
  })

  describe('with an activation transaction in flight', () => {
    const listing = ['kingud-0.1.0+01d', 'kingud-0.2.0+9ee0', 'kingud-0.3.0+cc0']
    const record = { ...emptyKingudActivationRecord(), active: '0.3.0+cc0' }
    const run = () =>
      gcOldKingudVersions({
        conn,
        host,
        remoteHome: '/home/u',
        currentDirAbsPath: '/home/u/.kingu-remote/kingud-0.3.0+cc0',
        record
      })

    it('keeps every slot a pending journal names', async () => {
      const removed: string[] = []
      const before = { ...record, previous: '0.1.0+01d' }
      scriptHost({
        listing,
        removed,
        journal: serializeKingudActivationTransaction(
          createKingudActivationTransaction({
            transactionId: '7f1c2a7e-6c1b-4a8e-9f0e-0a1b2c3d4e5f',
            candidateVersion: '0.2.0+9ee0',
            recordBefore: before,
            snapshotDirName: 'pre-0.2.0+9ee0-1',
            now: new Date(0)
          })
        )
      })
      await run()
      expect(removed).toEqual([])
    })

    it.each([
      ['an unreadable journal', { journal: '{"schemaVersion":99}' }],
      ['a journal read with no answer', { journal: new Error('lost') }],
      ['a held fence without a journal', { fenceHeld: true }]
    ])('collects nothing behind %s', async (_name, state) => {
      const removed: string[] = []
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      scriptHost({ listing, removed, ...state })
      await run()
      expect(removed).toEqual([])
      expect(mockExec.mock.calls.some(([, command]) => command.includes('-mindepth 1'))).toBe(false)
    })

    it('never names a snapshot or rescue copy as a candidate', async () => {
      const removed: string[] = []
      scriptHost({ listing: [...listing, 'kingud-state-snapshots'], removed })
      await run()
      expect(removed).not.toContain('kingud-state-snapshots')
    })
  })
})
