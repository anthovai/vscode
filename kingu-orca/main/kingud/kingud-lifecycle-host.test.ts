import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./kingud-browser-startup', () => ({
  startKingudBrowserProvider: () => ({ ready: Promise.resolve(), stop: async () => {} })
}))

import { KINGUD_LOCK_FILE_NAME, readKingudInstanceLockRecord } from './kingud-instance-lock'
import { startKingudWithHost } from './kingud-lifecycle'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kingud-lifecycle-host-'))
  roots.push(root)
  return root
}

describe('startKingudWithHost', () => {
  it('names the instance a managed stop must address, and releases its lock on a clean stop', async () => {
    const root = dataRoot()
    const handle = await startKingudWithHost(
      root,
      async () => ({}),
      () => {}
    )
    expect(readKingudInstanceLockRecord(handle.instance.lockPath)).toMatchObject({
      pid: handle.instance.pid,
      nonce: handle.instance.nonce
    })
    await handle.stop()
    expect(existsSync(join(root, KINGUD_LOCK_FILE_NAME))).toBe(false)
  })

  it('keeps the instance lock when a runtime writer could not be stopped', async () => {
    const root = dataRoot()
    const failure = new Error('profile writer still running')
    const handle = await startKingudWithHost(
      root,
      async (registerCleanup) => {
        registerCleanup(() => {
          throw failure
        })
        return {}
      },
      () => {}
    )
    await expect(handle.stop()).rejects.toBe(failure)
    expect(existsSync(join(root, KINGUD_LOCK_FILE_NAME))).toBe(true)
  })

  it('keeps the instance lock when a quit handler fails', async () => {
    const root = dataRoot()
    const handle = await startKingudWithHost(
      root,
      async () => ({}),
      () => {
        throw new AggregateError([new Error('handler')], 'kingud_quit_handlers_failed')
      }
    )
    await expect(handle.stop()).rejects.toThrow('kingud_quit_handlers_failed')
    expect(existsSync(join(root, KINGUD_LOCK_FILE_NAME))).toBe(true)
  })
})
