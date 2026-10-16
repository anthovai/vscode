import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  consumeKingudIdleStopRecord,
  kingudIdleStopRecordPath,
  writeKingudIdleStopRecord
} from './kingud-idle-stop-record'
import { createIdleStopRecordOwnership } from './kingud-managed-idle-exit-host'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kingud-idle-stop-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('kingud idle-stop record', () => {
  it('lets the next start tell an idle stop apart from a crash, exactly once', () => {
    writeKingudIdleStopRecord(
      root,
      {
        quietSince: Date.parse('2026-10-03T10:00:00Z'),
        stoppedAt: Date.parse('2026-10-03T10:15:00Z'),
        timeoutMs: 900_000
      },
      '1.2.3'
    )

    expect(consumeKingudIdleStopRecord(root)).toMatchObject({
      kind: 'kingud_idle_stop',
      pid: process.pid,
      version: '1.2.3',
      quietSince: '2026-10-03T10:00:00.000Z',
      stoppedAt: '2026-10-03T10:15:00.000Z',
      idleTimeoutMs: 900_000
    })
    // A crash after this start must not inherit the earlier idle stop.
    expect(consumeKingudIdleStopRecord(root)).toBeNull()
  })

  it('reads a start with no record as "not an idle stop"', () => {
    expect(consumeKingudIdleStopRecord(root)).toBeNull()
  })

  it('drops a corrupt record instead of trusting it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(kingudIdleStopRecordPath(root), '{"kind":"kingud_idle_stop"')

    expect(consumeKingudIdleStopRecord(root)).toBeNull()
    expect(existsSync(kingudIdleStopRecordPath(root))).toBe(false)
  })

  it('drops the record when a signal stop already owned the shutdown', () => {
    const evidence = { quietSince: 1, stoppedAt: 2, timeoutMs: 3 }
    writeKingudIdleStopRecord(root, evidence, '1.0.0')
    createIdleStopRecordOwnership(root).requestShutdown(() => false)
    expect(existsSync(kingudIdleStopRecordPath(root))).toBe(false)

    writeKingudIdleStopRecord(root, evidence, '1.0.0')
    const owned = createIdleStopRecordOwnership(root)
    let onFailed: (() => void) | undefined
    owned.requestShutdown((_reason, failed) => {
      onFailed = failed
      return true
    })
    owned.onShutdown()
    expect(existsSync(kingudIdleStopRecordPath(root))).toBe(true)
    onFailed?.()
    expect(existsSync(kingudIdleStopRecordPath(root))).toBe(false)
  })

  it('drops the record when a signal stop finishes before the idle stop asks to shut down', () => {
    writeKingudIdleStopRecord(root, { quietSince: 1, stoppedAt: 2, timeoutMs: 3 }, '1.0.0')
    // The signal's stop runs every cleanup, then exits before the idle request ever runs.
    createIdleStopRecordOwnership(root).onShutdown()
    expect(existsSync(kingudIdleStopRecordPath(root))).toBe(false)
  })
})
