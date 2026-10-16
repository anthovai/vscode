import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as WindowsAcl from '../../shared/secure-path-windows-acl'
import {
  KINGUD_CANCEL_MANAGED_STOP_FLAG,
  KingudManagedStopCancellationSchema,
  type KingudManagedStopRequest
} from '../../shared/kingud-stop-request'
import { acquireKingudInstanceLock } from './kingud-instance-lock'
import { kingudManagedStopRequestPath } from './kingud-managed-stop-request'
import { cancelKingudManagedStop } from './kingud-managed-stop-cancellation'
import {
  claimKingudManagedStopDecision,
  readKingudManagedStopDecision
} from './kingud-managed-stop-decision'
import { completeKingudManagedStop } from './kingud-managed-stop-completion'
import { runKingudManagedStopCancelCommand } from './kingud-managed-stop-command'
import { installKingudStopRequestListeners } from './kingud-stop-request-listener'

const hardening = vi.hoisted(() => ({ pending: new Set<Promise<void>>() }))

vi.mock('../../shared/secure-path-windows-acl', async (importOriginal) => {
  const acl = await importOriginal<typeof WindowsAcl>()
  return {
    ...acl,
    restrictWindowsDirectory: (dirPath: string): Promise<boolean> => {
      const restricted = acl.restrictWindowsDirectory(dirPath)
      const pending = restricted.then(() => undefined)
      hardening.pending.add(pending)
      void pending.then(() => hardening.pending.delete(pending))
      return restricted
    }
  }
})

const roots: string[] = []
afterEach(async () => {
  // ACL updates must finish before their temporary directories disappear.
  await Promise.all(hardening.pending)
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})

function running(): KingudManagedStopRequest {
  const root = mkdtempSync(join(tmpdir(), 'kingud-stop-cancel-'))
  roots.push(root)
  const lock = acquireKingudInstanceLock(root, { identity: () => 'uid-1000', startedAtMs: () => 5 })
  const { pid, startedAtMs, nonce } = lock.record
  return {
    schemaVersion: 1,
    transactionId: '0b9f6a3e-9e2c-4c8e-8f58-4c0f6b1d2e3a',
    version: '1.0.0',
    runtimeId: 'runtime-1',
    instance: { pid, startedAtMs, nonce, lockPath: lock.path }
  }
}

describe('cancelling a managed stop', () => {
  it('lets exactly one side decide a transaction', () => {
    const request = running()
    expect(claimKingudManagedStopDecision(request, 'canceled')).toBe('canceled')
    expect(claimKingudManagedStopDecision(request, 'dispatched')).toBe('canceled')
    expect(readKingudManagedStopDecision(request)).toBe('canceled')
  })

  it('withdraws a request kingud has not acted on, and removes its file', () => {
    const request = running()
    writeFileSync(kingudManagedStopRequestPath(request.instance), JSON.stringify(request))
    expect(cancelKingudManagedStop(request)).toBe('canceled')
    expect(existsSync(kingudManagedStopRequestPath(request.instance))).toBe(false)
  })

  it('reports dispatched once kingud acted first, and leaves its request in place', () => {
    const request = running()
    writeFileSync(kingudManagedStopRequestPath(request.instance), JSON.stringify(request))
    expect(claimKingudManagedStopDecision(request, 'dispatched')).toBe('dispatched')
    expect(cancelKingudManagedStop(request)).toBe('dispatched')
    expect(existsSync(kingudManagedStopRequestPath(request.instance))).toBe(true)
  })

  it('never removes another transaction pending for the same instance', () => {
    const request = running()
    const other = { ...request, transactionId: '5a7e1f0c-3b2d-4e6f-9a8b-7c6d5e4f3a2b' }
    writeFileSync(kingudManagedStopRequestPath(request.instance), JSON.stringify(other))
    expect(cancelKingudManagedStop(request)).toBe('canceled')
    expect(existsSync(kingudManagedStopRequestPath(request.instance))).toBe(true)
  })

  it('does not reissue a cancelled transaction while kingud keeps running', async () => {
    const request = running()
    cancelKingudManagedStop(request)
    expect(
      await completeKingudManagedStop(request, {
        probeProcess: () => 'alive',
        startedAtMs: () => 5,
        sleep: async () => {}
      })
    ).toBe('live')
    expect(existsSync(kingudManagedStopRequestPath(request.instance))).toBe(false)
  })

  it('keeps kingud running when its listener meets a cancelled request', async () => {
    const request = running()
    cancelKingudManagedStop(request)
    writeFileSync(kingudManagedStopRequestPath(request.instance), JSON.stringify(request))
    const onRequest = vi.fn()
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = mkdtempSync(join(tmpdir(), 'kingud-stop-cancel-slot-'))
    roots.push(root)
    const listener = installKingudStopRequestListeners(onRequest, {
      installRoot: root,
      managedStop: {
        version: request.version,
        runtimeId: request.runtimeId,
        instance: request.instance
      },
      pollIntervalMs: 10
    })
    await vi.waitFor(() => expect(report).toHaveBeenCalled())
    listener.close()
    expect(onRequest).not.toHaveBeenCalled()
    expect(String(report.mock.calls[0]?.[1])).toContain('kingud_managed_stop_canceled')
    // Left in place, it would make every later transaction's completion answer unverifiable.
    expect(existsSync(kingudManagedStopRequestPath(request.instance))).toBe(false)
  })

  it('prints one cancellation line through the command', () => {
    const request = running()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const cancellation = runKingudManagedStopCancelCommand([
      KINGUD_CANCEL_MANAGED_STOP_FLAG,
      JSON.stringify(request)
    ])
    expect(cancellation.outcome).toBe('canceled')
    expect(
      KingudManagedStopCancellationSchema.parse(JSON.parse(String(write.mock.calls[0]?.[0])))
    ).toEqual(cancellation)
  })
})
