import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { kingudArtifactFilenames } from '../../shared/kingud-artifacts'
import { runKingudProfilePreflight } from './kingud-profile-preflight'
import { readKingudArtifactIdentity } from './kingud-artifact-identity'
import { resolveKingudExitCode } from './kingud-exit-code'

const fixture = vi.hoisted(() => ({
  directory: '',
  sqlite: vi.fn(async () => ({ sqliteVersion: '3.53.2', revision: 1 }))
}))
vi.mock('./kingud-app-paths', () => ({ resolveKingudInstallRoot: () => fixture.directory }))
vi.mock('../persistence/profile-state/profile-state-runtime-preflight', () => ({
  preflightProfileStateRuntime: fixture.sqlite
}))
vi.mock('./kingud-bun-native-preflight', () => ({
  preflightKingudBunNativeRuntime: vi.fn(async () => {})
}))

beforeEach(async () => {
  fixture.directory = await mkdtemp(join(tmpdir(), 'kingud-artifact-preflight-'))
  for (const filename of kingudArtifactFilenames('linux-x64-glibc')) {
    const path = join(fixture.directory, filename)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, filename === '.build-target' ? 'linux-x64-glibc\n' : filename)
  }
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await rm(fixture.directory, { recursive: true, force: true })
})

describe('installed artifact admission', () => {
  it('qualifies build output before its version marker is published', async () => {
    await runKingudProfilePreflight(randomUUID())
    expect(fixture.sqlite).toHaveBeenCalledOnce()
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(await readKingudArtifactIdentity(fixture.directory))
    )
  })

  it.each(['.build-target', 'node_modules/@parcel/watcher/watcher.node', 'bun-runtime'])(
    'refuses a missing %s as configuration before any profile probe',
    async (filename) => {
      await rm(join(fixture.directory, filename))
      const error = await runKingudProfilePreflight(randomUUID()).catch(
        (failure: unknown) => failure
      )
      expect(resolveKingudExitCode(error)).toBe(78)
      expect(fixture.sqlite).not.toHaveBeenCalled()
      expect(console.log).not.toHaveBeenCalled()
    }
  )

  it('refuses a malformed target even though all named files exist', async () => {
    await writeFile(join(fixture.directory, '.build-target'), 'not-a-runtime-target')
    const error = await runKingudProfilePreflight(randomUUID()).catch((failure: unknown) => failure)
    expect(resolveKingudExitCode(error)).toBe(78)
    expect(fixture.sqlite).not.toHaveBeenCalled()
  })
})
