import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import {
  acquireProfileStateMaintenance,
  acquireProfileStateRuntimeAdmission
} from '../persistence/profile-state/profile-state-access'
import * as database from '../persistence/profile-state/profile-state-database'
import { exportProfileStateJson } from '../persistence/profile-state/profile-state-documents'
import {
  getKinguProfileDataFile,
  getKinguProfileStateDatabaseFile,
  seedNewKinguProfileTelemetryConsent
} from './profile-index-store'

const telemetry = {
  optedIn: false,
  installId: 'retained-install-id',
  existedBeforeTelemetryRelease: true
}
let root: string
const profileId = 'new-profile'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kingu-profile-consent-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  removeTreeSync(root)
})

describe('new profile consent seeding', () => {
  it('inherits consent and install identity directly into SQLite alongside the active runtime', () => {
    const runtime = acquireProfileStateRuntimeAdmission(root)
    try {
      seedNewKinguProfileTelemetryConsent(profileId, telemetry, root)
      const opened = database.openProfileStateDatabaseReadOnly(
        getKinguProfileStateDatabaseFile(profileId, root),
        profileId
      )
      try {
        expect(JSON.parse(exportProfileStateJson(opened.db))).toEqual({ settings: { telemetry } })
      } finally {
        opened.db.close()
      }
      expect(existsSync(getKinguProfileDataFile(profileId, root))).toBe(false)
      expect(() => runtime.assertActive()).not.toThrow()
    } finally {
      runtime.release()
    }
    const maintenance = acquireProfileStateMaintenance(root)
    maintenance.release()
  })

  it('preserves established SQLite consent on a repeated seed', () => {
    seedNewKinguProfileTelemetryConsent(profileId, telemetry, root)
    seedNewKinguProfileTelemetryConsent(profileId, { ...telemetry, installId: 'replacement' }, root)
    const opened = database.openProfileStateDatabaseReadOnly(
      getKinguProfileStateDatabaseFile(profileId, root),
      profileId
    )
    try {
      expect(JSON.parse(exportProfileStateJson(opened.db))).toEqual({ settings: { telemetry } })
    } finally {
      opened.db.close()
    }
  })

  it('preserves existing JSON as input for its later import', () => {
    const path = getKinguProfileDataFile(profileId, root)
    const original = '{"settings":{"telemetry":{"installId":"older"}}}'
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, original)

    seedNewKinguProfileTelemetryConsent(profileId, telemetry, root)

    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(existsSync(getKinguProfileStateDatabaseFile(profileId, root))).toBe(false)
  })

  it('refuses an incapable runtime before admission or profile creation', () => {
    vi.spyOn(database, 'isProfileStateSqliteAvailable').mockReturnValue(false)
    expect(() => seedNewKinguProfileTelemetryConsent(profileId, telemetry, root)).toThrow(
      'bundled Kingu runtime'
    )
    expect(existsSync(join(root, '.profile-state-access'))).toBe(false)
    expect(existsSync(join(root, 'profiles'))).toBe(false)
  })

  it('refuses seeding while maintenance owns the root', () => {
    const maintenance = acquireProfileStateMaintenance(root)
    try {
      expect(() => seedNewKinguProfileTelemetryConsent(profileId, telemetry, root)).toThrow()
      expect(existsSync(getKinguProfileStateDatabaseFile(profileId, root))).toBe(false)
    } finally {
      maintenance.release()
    }
  })

  it.each([
    'kingu-data.json.bak.0',
    'kingu-data.json.sqlite-export.1.json',
    'profile-state.db-wal'
  ])('retains missing-authority evidence in %s', (name) => {
    const directory = dirname(getKinguProfileDataFile(profileId, root))
    mkdirSync(directory, { recursive: true })
    const evidence = join(directory, name)
    writeFileSync(evidence, 'retained recovery evidence')

    expect(() => seedNewKinguProfileTelemetryConsent(profileId, telemetry, root)).toThrow()

    expect(existsSync(getKinguProfileDataFile(profileId, root))).toBe(false)
    expect(existsSync(getKinguProfileStateDatabaseFile(profileId, root))).toBe(false)
    expect(readFileSync(evidence, 'utf8')).toBe('retained recovery evidence')
  })
})
