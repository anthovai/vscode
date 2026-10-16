import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stampKingudAppVersion } from './kingud-host-adapters'

describe('the Kingu version a server reports', () => {
  let root: string
  let saved: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kingud-app-version-'))
    saved = process.env.KINGU_APP_VERSION
    delete process.env.KINGU_APP_VERSION
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    if (saved === undefined) {
      delete process.env.KINGU_APP_VERSION
    } else {
      process.env.KINGU_APP_VERSION = saved
    }
  })

  it('is the release its bundle was built from, not a dev placeholder', () => {
    mkdirSync(join(root, 'out', 'cli'), { recursive: true })
    writeFileSync(join(root, 'out', 'package.json'), JSON.stringify({ version: '1.4.224' }))
    stampKingudAppVersion(() => root)
    expect(process.env.KINGU_APP_VERSION).toBe('1.4.224')
  })

  it('replaces a version inherited from the Kingu that started it', () => {
    process.env.KINGU_APP_VERSION = '1.4.300'
    mkdirSync(join(root, 'out'), { recursive: true })
    writeFileSync(join(root, 'out', 'package.json'), JSON.stringify({ version: '1.4.224' }))
    stampKingudAppVersion(() => root)
    expect(process.env.KINGU_APP_VERSION).toBe('1.4.224')
  })

  it('leaves the environment alone when the bundle has no version', () => {
    stampKingudAppVersion(() => root)
    expect(process.env.KINGU_APP_VERSION).toBeUndefined()
    stampKingudAppVersion(() => {
      throw new Error('kingud_install_root_unavailable')
    })
    expect(process.env.KINGU_APP_VERSION).toBeUndefined()
  })
})
