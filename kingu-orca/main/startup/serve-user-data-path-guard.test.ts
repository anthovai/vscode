import { describe, expect, it, vi } from 'vitest'
import { checkServeUserDataPath } from './serve-user-data-path-guard'

describe('checkServeUserDataPath', () => {
  it('refuses a serve that landed on a profile other than the one the CLI chose', () => {
    const env: NodeJS.ProcessEnv = { KINGU_SERVE_USER_DATA_PATH: '/isolated/profile' }
    expect(
      checkServeUserDataPath({ isServeMode: true, userDataPath: '/default/kingu', env })
    ).toContain('/isolated/profile')
    expect(env.KINGU_SERVE_USER_DATA_PATH).toBeUndefined()
  })

  it('allows the chosen profile, including another spelling of it', () => {
    expect(
      checkServeUserDataPath({
        isServeMode: true,
        userDataPath: '/isolated/profile',
        env: { KINGU_SERVE_USER_DATA_PATH: '/isolated/./profile/' }
      })
    ).toBeNull()
    expect(
      checkServeUserDataPath({
        isServeMode: true,
        userDataPath: 'C:\\Users\\Me\\Kingu',
        env: { KINGU_SERVE_USER_DATA_PATH: 'c:\\users\\me\\kingu' },
        platform: 'win32'
      })
    ).toBeNull()
  })

  it('leaves launches without a CLI choice, or outside serve, alone', () => {
    expect(checkServeUserDataPath({ isServeMode: true, userDataPath: '/a', env: {} })).toBeNull()
    const env: NodeJS.ProcessEnv = { KINGU_SERVE_USER_DATA_PATH: '/b' }
    expect(checkServeUserDataPath({ isServeMode: false, userDataPath: '/a', env })).toBeNull()
    expect(env.KINGU_SERVE_USER_DATA_PATH).toBeUndefined()
  })
})

describe('configureKinguUserDataPathEnv on a serve launch', () => {
  it('throws before the instance lock instead of publishing a mismatched profile', async () => {
    vi.doMock('electron', () => ({ app: { getPath: () => '/default/kingu' } }))
    const { configureKinguUserDataPathEnv } = await import('./configure-process')
    const argv = process.argv
    const previous = process.env.KINGU_USER_DATA_PATH
    process.argv = [...argv, '--serve']
    process.env.KINGU_SERVE_USER_DATA_PATH = '/isolated/profile'
    process.env.KINGU_USER_DATA_PATH = '/isolated/profile'
    try {
      expect(() => configureKinguUserDataPathEnv()).toThrow('/isolated/profile')
      expect(process.env.KINGU_USER_DATA_PATH).toBe('/isolated/profile')
    } finally {
      process.argv = argv
      delete process.env.KINGU_SERVE_USER_DATA_PATH
      if (previous === undefined) {
        delete process.env.KINGU_USER_DATA_PATH
      } else {
        process.env.KINGU_USER_DATA_PATH = previous
      }
      vi.doUnmock('electron')
    }
  })
})
