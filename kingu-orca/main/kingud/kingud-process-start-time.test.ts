import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as DaemonProcessStartTime from '../daemon/daemon-process-start-time'

const { readWindowsProcessCreationTime, getProcessStartedAtMs } = vi.hoisted(() => ({
  readWindowsProcessCreationTime: vi.fn<(pid: number) => number | null>(),
  getProcessStartedAtMs: vi.fn<(pid: number) => number | null>()
}))
vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessCreationTime
}))
vi.mock('../daemon/daemon-process-start-time', async (importOriginal) => ({
  ...(await importOriginal<typeof DaemonProcessStartTime>()),
  getProcessStartedAtMs
}))

import {
  compareKingudProcessIdentity,
  readKingudProcessIncarnation,
  readKingudProcessStartedAtMs
} from './kingud-process-start-time'

const platform = process.platform
function onPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

afterEach(() => {
  onPlatform(platform)
  vi.resetAllMocks()
})

describe('kingud process start time', () => {
  it('reads the addon creation time on Windows, never the POSIX probe', () => {
    onPlatform('win32')
    readWindowsProcessCreationTime.mockReturnValue(1_700_000_000_123)
    expect(readKingudProcessStartedAtMs(42)).toBe(1_700_000_000_123)
    expect(readWindowsProcessCreationTime).toHaveBeenCalledWith(42)
    expect(getProcessStartedAtMs).not.toHaveBeenCalled()
  })

  it('keeps the POSIX probe elsewhere', () => {
    onPlatform('linux')
    getProcessStartedAtMs.mockReturnValue(5_000)
    expect(readKingudProcessStartedAtMs(42)).toBe(5_000)
    expect(readWindowsProcessCreationTime).not.toHaveBeenCalled()
  })

  it('tells a reused Windows PID apart, and fails open when the addon cannot answer', () => {
    onPlatform('win32')
    readWindowsProcessCreationTime.mockReturnValue(9_000_000)
    expect(compareKingudProcessIdentity(42, { startedAtMs: 1_000 })).toBe('differs')
    expect(compareKingudProcessIdentity(42, { startedAtMs: 9_000_100 })).toBe('matches')
    readWindowsProcessCreationTime.mockReturnValue(null)
    expect(compareKingudProcessIdentity(42, { startedAtMs: 1_000 })).toBe('unknown')
  })
})

describe('kingud process identity', () => {
  const incarnation = { linuxStartTicks: '1234', bootId: 'boot-a' }
  const recorded = { startedAtMs: 1_000, ...incarnation }

  it('matches on ticks and boot id even when the btime-derived start time drifted', () => {
    expect(
      compareKingudProcessIdentity(42, recorded, {
        startedAtMs: () => 158_000,
        incarnation: () => incarnation,
        platform: 'linux'
      })
    ).toBe('matches')
  })

  it.each([
    ['different start ticks', { ...incarnation, linuxStartTicks: '9999' }],
    ['a different boot', { ...incarnation, bootId: 'boot-b' }]
  ])('proves reuse on %s', (_name, actual) => {
    expect(compareKingudProcessIdentity(42, recorded, { incarnation: () => actual })).toBe(
      'differs'
    )
  })

  it('is unknown, never different, when the incarnation cannot be read', () => {
    expect(compareKingudProcessIdentity(42, recorded, { incarnation: () => null })).toBe('unknown')
  })

  it('reads a Linux wall-clock mismatch on a record without ticks as unproven', () => {
    expect(
      compareKingudProcessIdentity(
        42,
        { startedAtMs: 1_000 },
        {
          startedAtMs: () => 158_000,
          incarnation: () => incarnation,
          platform: 'linux'
        }
      )
    ).toBe('unproven')
  })
})

describe.runIf(platform === 'linux')('kingud process incarnation on a real /proc', () => {
  it('reads ticks and the boot id, even for a command name with spaces and parens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kingud-incarnation-'))
    const odd = join(dir, 'x) y (z')
    symlinkSync('/bin/sleep', odd)
    const child = spawn(odd, ['30'], { stdio: 'ignore' })
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      const pid = child.pid ?? 0
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      const own = readKingudProcessIncarnation(process.pid)
      const other = readKingudProcessIncarnation(pid)
      expect(own).toEqual({
        linuxStartTicks: expect.stringMatching(/^\d+$/),
        bootId
      })
      expect(other).toEqual({
        linuxStartTicks: expect.stringMatching(/^\d+$/),
        bootId
      })
      expect(compareKingudProcessIdentity(pid, { startedAtMs: null, ...other })).toBe('matches')
      // This test process started well before the child, so its ticks name another process.
      expect(compareKingudProcessIdentity(pid, { startedAtMs: null, ...own })).toBe('differs')
    } finally {
      child.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers null for a PID that does not exist', () => {
    expect(readKingudProcessIncarnation(2 ** 30)).toBeNull()
  })
})
