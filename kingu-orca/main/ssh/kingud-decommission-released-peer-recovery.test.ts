/**
 * A stop interrupted on a newer desktop, then recovered by a released, older one. Its parser,
 * recovery planner and auto-update planner below are frozen copies of what already shipped, so
 * this pins the journal form against code that can no longer change.
 */
import { describe, expect, it } from 'vitest'
import {
  coreKingudActivationRecord,
  serializeKingudActivationRecord,
  type KingudActivationRecord
} from './kingud-activation-record'
import {
  parseKingudActivationTransaction,
  serializeKingudActivationTransaction
} from './kingud-activation-transaction'
import {
  createKingudDecommissionTransaction,
  withKingudDecommissionProcessExited,
  withKingudDecommissionStopDispatched,
  type KingudDecommissionTransaction
} from './kingud-decommission-transaction'
import { FakeKingudHost, NEW, OLD } from './kingud-activation-host-test-harness'
import { compareAppVersions } from '../../shared/app-version'
import type { KingudManagedStopRequest } from '../../shared/kingud-stop-request'

const T = new Date('2026-02-02T00:00:00.000Z')
const ID = '7f1c2a7e-6c1b-4a8e-9f0e-0a1b2c3d4e5f'
const NEWER_APP = '1.6.0'
const RELEASED_APP = '1.5.0'
const before: KingudActivationRecord & { active: string } = {
  ...FakeKingudHost.newRecord(),
  active: NEW,
  activeAppVersion: NEWER_APP
}
const request: KingudManagedStopRequest = {
  schemaVersion: 1,
  transactionId: ID,
  version: NEW,
  runtimeId: 'runtime-1',
  instance: { pid: 42, startedAtMs: 5, nonce: 'nonce', lockPath: '/home/u/.kingu/kingud.lock' },
  retireIdleDaemon: true
}
const prepared = createKingudDecommissionTransaction({
  transactionId: ID,
  recordBefore: before,
  now: T
})
const dispatched = withKingudDecommissionStopDispatched(prepared, request, T)
const exited = withKingudDecommissionProcessExited(dispatched, T)

type ReleasedJournal = {
  phase: string
  request: unknown
  activeVersion: string
  recordBefore: KingudActivationRecord
  recordAfter: KingudActivationRecord
}

const sameCore = (a: KingudActivationRecord, b: KingudActivationRecord): boolean =>
  serializeKingudActivationRecord(coreKingudActivationRecord(a)) ===
  serializeKingudActivationRecord(coreKingudActivationRecord(b))

/** Frozen: the released parser's decommission checks; its zod object drops unknown fields. */
function releasedParse(raw: string): ReleasedJournal {
  const journal: ReleasedJournal = JSON.parse(raw)
  if ((journal.phase === 'prepared') !== (journal.request === null)) {
    throw new Error('Stop request is inconsistent with phase')
  }
  const b = journal.recordBefore
  const deactivated = {
    schemaVersion: 1,
    active: null,
    previous: b.active,
    activatedAt: null,
    snapshot: null
  }
  if (JSON.stringify(journal.recordAfter) !== JSON.stringify(deactivated)) {
    throw new Error('recordAfter is not the deactivated recordBefore')
  }
  return journal
}

/** Frozen: released recovery, as the record it leaves once the stop is settled as exited. */
function releasedRecover(
  journal: ReleasedJournal,
  current: KingudActivationRecord
): KingudActivationRecord {
  if (sameCore(current, journal.recordAfter)) {
    return current
  }
  if (!sameCore(current, journal.recordBefore)) {
    throw new Error('record changed')
  }
  // process-exited confirms, stop-dispatched resumes the stop: both write recordAfter verbatim.
  return journal.phase === 'prepared' ? current : journal.recordAfter
}

/** Frozen: the released auto-update planner for a host with nothing newer rolled back. */
function releasedAutoUpdate(record: KingudActivationRecord, candidate: string): 'update' | 'skip' {
  if (record.active === candidate || record.rolledBackFrom === candidate) {
    return 'skip'
  }
  return record.activeAppVersion && compareAppVersions(record.activeAppVersion, RELEASED_APP) > 0
    ? 'skip'
    : 'update'
}

function releasedPeerAfterRecovery(raw: string): 'update' | 'skip' {
  return releasedAutoUpdate(releasedRecover(releasedParse(raw), before), OLD)
}

describe('a released desktop recovering a newer desktop’s interrupted stop', () => {
  it.each([
    ['prepared', prepared],
    ['stop-dispatched', dispatched],
    ['process-exited', exited]
  ])('never downgrades the host from %s', (_phase, transaction: KingudDecommissionTransaction) => {
    expect(releasedPeerAfterRecovery(serializeKingudActivationTransaction(transaction))).toBe(
      'skip'
    )
  })

  it('would downgrade it if the journal named the dispatched phase at the top level', () => {
    expect(releasedPeerAfterRecovery(JSON.stringify(exited))).toBe('update')
  })

  it('still reads the real phase and request on a current desktop', () => {
    for (const transaction of [prepared, dispatched, exited]) {
      const raw = serializeKingudActivationTransaction({ ...transaction, fenceToken: 'token-1' })
      expect(JSON.parse(raw)).toMatchObject({
        phase: 'prepared',
        request: null,
        fenceToken: 'token-1'
      })
      expect(parseKingudActivationTransaction(raw)).toEqual({ state: 'ok', transaction })
    }
  })

  it.each([
    [
      'filed twice',
      {
        ...JSON.parse(serializeKingudActivationTransaction(exited)),
        phase: 'process-exited',
        request
      }
    ],
    [
      'for another transaction',
      {
        ...JSON.parse(serializeKingudActivationTransaction(exited)),
        dispatched: {
          phase: 'process-exited',
          request: { ...request, transactionId: '5a7e1f0c-3b2d-4e6f-9a8b-7c6d5e4f3a2b' }
        }
      }
    ]
  ])('reads a dispatched stop %s as unreadable', (_name, journal) => {
    expect(parseKingudActivationTransaction(JSON.stringify(journal))).toMatchObject({
      state: 'unreadable'
    })
  })
})
