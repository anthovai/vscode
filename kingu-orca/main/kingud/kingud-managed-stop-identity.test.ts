import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  KingudManagedStopRequestSchema,
  type KingudManagedStopRequest
} from '../../shared/kingud-stop-request'
import { acquireKingudInstanceLock } from './kingud-instance-lock'
import { kingudManagedStopRequestPath } from './kingud-managed-stop-request'
import {
  completeKingudManagedStop,
  type KingudManagedStopCompletionOptions
} from './kingud-managed-stop-completion'
import { kingudStopReceiptPath } from './kingud-completed-stop-receipt'
import type { KingudProcessIncarnation } from './kingud-process-start-time'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const RECORDED: KingudProcessIncarnation = {
  linuxStartTicks: '4242',
  bootId: 'boot-a'
}
// The WSL2 smoke saw btime move by 157 s against a 1.5 s tolerance.
const DRIFTED_STARTED_AT_MS = 5_000 + 157_000

function running(
  recorded: KingudProcessIncarnation | null,
  { requestCarriesIncarnation = false } = {}
): KingudManagedStopRequest {
  const root = mkdtempSync(join(tmpdir(), 'kingud-stop-identity-'))
  roots.push(root)
  const lock = acquireKingudInstanceLock(root, {
    identity: () => 'uid-1000',
    startedAtMs: () => 5_000,
    incarnation: () => recorded
  })
  const { pid, startedAtMs, nonce } = lock.record
  return {
    schemaVersion: 1,
    transactionId: '0b9f6a3e-9e2c-4c8e-8f58-4c0f6b1d2e3a',
    version: '1.0.0',
    runtimeId: 'runtime-1',
    instance: {
      pid,
      startedAtMs,
      ...(requestCarriesIncarnation && recorded ? recorded : {}),
      nonce,
      lockPath: lock.path
    }
  }
}

/** Alive for `aliveFor` observations, then gone. */
function linuxHost(
  actual: KingudProcessIncarnation | null,
  aliveFor = Number.POSITIVE_INFINITY
): KingudManagedStopCompletionOptions {
  let observations = 0
  return {
    platform: 'linux',
    probeProcess: () => (observations++ < aliveFor ? 'alive' : 'missing'),
    startedAtMs: () => DRIFTED_STARTED_AT_MS,
    incarnation: () => actual,
    sleep: async () => {},
    attempts: 3,
    now: () => new Date('2026-10-01T00:00:00.000Z')
  }
}

const requestWritten = (request: KingudManagedStopRequest): boolean =>
  existsSync(kingudManagedStopRequestPath(request.instance))

describe('managed stop instance identity', () => {
  it.each([
    ['the lock', false],
    ['the request', true]
  ])(
    'keeps a drifted-btime instance live by its ticks from %s, writes the request, then proves exit',
    async (_source, requestCarriesIncarnation) => {
      const request = running(RECORDED, { requestCarriesIncarnation })
      expect(await completeKingudManagedStop(request, linuxHost(RECORDED, 2))).toBe('exited')
      expect(requestWritten(request)).toBe(true)
      expect(existsSync(kingudStopReceiptPath(request, 'completed'))).toBe(true)
    }
  )

  it.each([
    ['different start ticks', { ...RECORDED, linuxStartTicks: '9999' }],
    ['a different boot', { ...RECORDED, bootId: 'boot-b' }]
  ])('proves exit for a PID now naming a process with %s', async (_name, actual) => {
    const request = running(RECORDED)
    expect(await completeKingudManagedStop(request, linuxHost(actual))).toBe('exited')
    expect(requestWritten(request)).toBe(false)
  })

  it('stays live, never exited, while the incarnation cannot be read', async () => {
    const request = running(RECORDED)
    expect(await completeKingudManagedStop(request, linuxHost(null))).toBe('live')
    expect(requestWritten(request)).toBe(true)
  })

  it('answers unverifiable, not exited, for an older lock whose wall-clock time drifted', async () => {
    const request = running(null)
    expect(await completeKingudManagedStop(request, linuxHost(RECORDED))).toBe('unverifiable')
    expect(existsSync(kingudStopReceiptPath(request, 'completed'))).toBe(false)
  })

  it('stays readable by peers on either side of the change', async () => {
    const request = running(RECORDED, { requestCarriesIncarnation: true })
    // The instance shape slots before this change parse: the incarnation is dropped, not refused.
    const olderInstance = z.object({
      pid: z.number().int().positive(),
      startedAtMs: z.number().finite().nonnegative().nullable(),
      nonce: z.string().min(1),
      lockPath: z.string().min(1)
    })
    const { linuxStartTicks: _ticks, bootId: _boot, ...withoutIncarnation } = request.instance
    expect(olderInstance.parse(request.instance)).toEqual(withoutIncarnation)
    // And a newer slot reads what an older client wrote, taking the incarnation from the lock.
    const fromOlderClient = KingudManagedStopRequestSchema.parse({
      ...request,
      instance: withoutIncarnation
    })
    expect(fromOlderClient.instance).not.toHaveProperty('linuxStartTicks')
    expect(await completeKingudManagedStop(fromOlderClient, linuxHost(RECORDED, 2))).toBe('exited')
    expect(
      JSON.parse(readFileSync(kingudManagedStopRequestPath(request.instance), 'utf8'))
    ).toEqual(fromOlderClient)
  })

  it('matches its own receipt when an older client retries without the incarnation', async () => {
    const request = running(RECORDED, { requestCarriesIncarnation: true })
    expect(await completeKingudManagedStop(request, linuxHost(RECORDED, 2))).toBe('exited')
    const { linuxStartTicks: _ticks, bootId: _boot, ...withoutIncarnation } = request.instance
    const retried = { ...request, instance: withoutIncarnation }
    expect(await completeKingudManagedStop(retried, linuxHost(RECORDED, 0))).toBe('exited')
  })
})
