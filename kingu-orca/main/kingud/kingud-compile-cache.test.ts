import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { KINGUD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/kingud-managed-launch-env'
import {
  KINGUD_COMPILE_CACHE_DIRNAME,
  enableManagedKingudCompileCache,
  kingudCompileCacheEnv
} from './kingud-compile-cache'

const managed = {
  [KINGUD_MANAGED_ACTIVATION_ROOT_ENV]: '/home/u/.kingu-remote/.fence'
}

describe('managed kingud compile cache', () => {
  it('caches inside a managed slot, where slot GC removes it with the slot', () => {
    const enableCompileCache = vi.fn()
    enableManagedKingudCompileCache('/home/u/.kingu-remote/kingud-1+ab', managed, {
      enableCompileCache
    })
    expect(enableCompileCache).toHaveBeenCalledWith(
      join('/home/u/.kingu-remote/kingud-1+ab', KINGUD_COMPILE_CACHE_DIRNAME)
    )
  })

  it('never writes into a slot no client manages, such as a packaged app', () => {
    const enableCompileCache = vi.fn()
    enableManagedKingudCompileCache('/Applications/Kingu.app/kingud', {}, { enableCompileCache })
    expect(enableCompileCache).not.toHaveBeenCalled()
  })

  it('starts as before on a runtime without the API or with an unwritable slot', () => {
    expect(() => enableManagedKingudCompileCache('/slot', managed, {})).not.toThrow()
    const enableCompileCache = vi.fn(() => {
      throw new Error('EACCES')
    })
    expect(() =>
      enableManagedKingudCompileCache('/slot', managed, { enableCompileCache })
    ).not.toThrow()
  })

  it('hands the preflight child the slot cache only when this process enabled one', () => {
    const enabled = { getCompileCacheDir: () => '/slot/x/v24' }
    expect(kingudCompileCacheEnv('/slot', enabled, managed)).toEqual({
      NODE_COMPILE_CACHE: join('/slot', KINGUD_COMPILE_CACHE_DIRNAME)
    })
    expect(
      kingudCompileCacheEnv('/slot', { getCompileCacheDir: () => undefined }, managed)
    ).toEqual({})
    expect(kingudCompileCacheEnv('/slot', {}, managed)).toEqual({})
    // Regression: an unmanaged kingud's own NODE_COMPILE_CACHE stays where the operator put it.
    expect(kingudCompileCacheEnv('/slot', enabled, {})).toEqual({})
  })
})
