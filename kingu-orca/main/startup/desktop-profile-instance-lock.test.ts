import { describe, expect, it, vi } from 'vitest'
import type { KingudInstanceLock } from '../kingud/kingud-instance-lock'
import { KingudInstanceLockError } from '../kingud/kingud-data-root-privacy'
import { acquireDesktopProfileInstanceLock } from './desktop-profile-instance-lock'

describe('the desktop share of the profile instance lock', () => {
  it('takes the lock as the desktop', () => {
    const lock: KingudInstanceLock = Object.assign(Object.create(null), { release: vi.fn() })
    const acquire = vi.fn(() => lock)
    expect(acquireDesktopProfileInstanceLock('/profile', acquire)).toEqual({
      state: 'acquired',
      lock
    })
    expect(acquire).toHaveBeenCalledWith('/profile', { role: 'desktop' })
  })

  it('refuses while a live kingud serves the profile, and says so', () => {
    const write = vi.fn()
    const result = acquireDesktopProfileInstanceLock(
      '/profile',
      () => {
        throw new KingudInstanceLockError('kingud_instance_lock_held', 'Another kingud (pid 7) ...')
      },
      write
    )
    expect(result).toEqual({
      state: 'held',
      message: 'Another kingud (pid 7) ...'
    })
    expect(write).toHaveBeenCalledWith(2, '[single-instance] Another kingud (pid 7) ...\n')
  })

  it('still starts when the lock cannot be taken for any other reason', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      acquireDesktopProfileInstanceLock('/profile', () => {
        throw new KingudInstanceLockError('kingud_instance_lock_unreadable', 'unreadable')
      })
    ).toEqual({ state: 'unavailable' })
  })
})
