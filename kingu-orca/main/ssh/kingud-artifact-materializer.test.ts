import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KINGUD_BUILD_TARGET_FILENAME,
  KINGUD_EMOJI_SHORTCODE_DATASET,
  KINGUD_RIPGREP_ARTIFACTS,
  KINGUD_TEMPLATE_MANIFEST_FILENAME,
  KINGUD_TEMPLATE_TARGETS_DIR,
  KINGUD_VERSION_FILENAME,
  kingudArtifactFilenames,
  kingudTemplateCommonFilenames
} from '../../shared/kingud-artifacts'
import type { KingudBunTarget } from '../../shared/kingud-bun-runtime'
import { z } from 'zod'
import { readKingudArtifactIdentity } from '../kingud/kingud-artifact-identity'
import {
  assembleKingudArtifact,
  materializeKingudArtifact,
  resetKingudArtifactMaterializationsForTests
} from './kingud-artifact-materializer'
import { materializeCachedKingudBunRuntime } from './kingud-bun-runtime-materializer'
import type * as BunRuntimeMaterializer from './kingud-bun-runtime-materializer'

vi.mock('./kingud-bun-runtime-materializer', async (importOriginal) => {
  const actual = await importOriginal<typeof BunRuntimeMaterializer>()
  return { ...actual, materializeCachedKingudBunRuntime: vi.fn() }
})

const TARGET = 'linux-x64-glibc' as const
const temporaryDirs: string[] = []

afterEach(() => {
  resetKingudArtifactMaterializationsForTests()
  vi.clearAllMocks()
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function createTemplate(target: KingudBunTarget = TARGET): {
  root: string
  templateDir: string
  cacheRoot: string
  runtimePath: string
} {
  const root = mkdtempSync(join(tmpdir(), 'kingud-artifact-template-'))
  temporaryDirs.push(root)
  const templateDir = join(root, 'template')
  const cacheRoot = join(root, 'cache')
  const runtimePath = join(root, 'bun-runtime')
  const common: Record<string, string> = {
    ...Object.fromEntries(kingudTemplateCommonFilenames().map((filename) => [filename, filename])),
    'kingud.js': 'kingud-entry',
    'daemon-entry.js': 'daemon-entry',
    'profile-state-writer-worker-entry.js': 'writer-entry',
    'profile-state-backup-worker-entry.js': 'backup-entry',
    'windows-bun-pty-gate-entry.js': 'pty-gate-entry',
    'parcel-watcher-process-entry.js': 'watcher-process',
    'node_modules/@parcel/watcher/index.js': 'watcher-wrapper',
    [KINGUD_EMOJI_SHORTCODE_DATASET]: '{}'
  }
  for (const [filename, contents] of Object.entries(common)) {
    write(join(templateDir, filename), contents)
  }
  const targetDir = join(templateDir, KINGUD_TEMPLATE_TARGETS_DIR, target)
  write(join(targetDir, KINGUD_BUILD_TARGET_FILENAME), `${target}\n`)
  write(join(targetDir, 'watcher.node'), 'native-watcher')
  write(join(targetDir, 'agent-browser-linux-x64'), 'browser')
  write(runtimePath, 'bun-executable')
  if (target.startsWith('win32-')) {
    write(join(templateDir, 'windows-process-tree.node'), 'process-table')
  }
  write(
    join(templateDir, KINGUD_TEMPLATE_MANIFEST_FILENAME),
    JSON.stringify({
      schemaVersion: 2,
      commonSha256: Object.fromEntries(
        Object.keys(common).map((filename) => [filename, sha256(join(templateDir, filename))])
      ),
      targets: {
        [target]: {
          targetSha256: sha256(join(targetDir, KINGUD_BUILD_TARGET_FILENAME)),
          watcherSha256: sha256(join(targetDir, 'watcher.node')),
          browserName: 'agent-browser-linux-x64',
          browserSha256: sha256(join(targetDir, 'agent-browser-linux-x64'))
        }
      }
    })
  )
  return { root, templateDir, cacheRoot, runtimePath }
}

describe('assembleKingudArtifact', () => {
  it.skipIf(process.platform === 'win32')(
    'restores executable search modes from a template copied without them',
    async () => {
      const fixture = createTemplate()
      const filenames = KINGUD_RIPGREP_ARTIFACTS.filter((filename) => filename.endsWith('/rg'))
      for (const filename of filenames) {
        chmodSync(join(fixture.templateDir, filename), 0o644)
      }
      const artifactDir = await assembleKingudArtifact({ ...fixture, target: TARGET })
      for (const filename of filenames) {
        expect(statSync(join(artifactDir, filename)).mode & 0o777).toBe(0o755)
      }
    }
  )

  it('gives Windows executable naming a new immutable slot identity', async () => {
    const target = 'win32-x64' as const
    const fixture = createTemplate(target)
    const artifactDir = await assembleKingudArtifact({ ...fixture, target })
    expect(readFileSync(join(artifactDir, 'bun-runtime.exe'), 'utf8')).toBe('bun-executable')
    expect(existsSync(join(artifactDir, 'bun-runtime'))).toBe(false)
    const oldHash = createHash('sha256')
    for (const filename of kingudArtifactFilenames(target)) {
      oldHash.update(readFileSync(join(artifactDir, filename)))
    }
    oldHash.update('browser')
    const oldVersion = `0.1.0+${oldHash.digest('hex').slice(0, 12)}`
    const oldDir = join(fixture.cacheRoot, target, oldVersion)
    write(join(oldDir, 'bun-runtime'), 'legacy-slot-must-stay-unchanged')
    expect(artifactDir).not.toBe(oldDir)
    await expect(assembleKingudArtifact({ ...fixture, target })).resolves.toBe(artifactDir)
    expect(readFileSync(join(oldDir, 'bun-runtime'), 'utf8')).toBe(
      'legacy-slot-must-stay-unchanged'
    )
  })

  it('assembles a complete content-addressed target directory', async () => {
    const fixture = createTemplate()
    const artifactDir = await assembleKingudArtifact({
      templateDir: fixture.templateDir,
      cacheRoot: fixture.cacheRoot,
      target: TARGET,
      runtimePath: fixture.runtimePath
    })

    const version = readFileSync(join(artifactDir, KINGUD_VERSION_FILENAME), 'utf8').trim()
    expect(version).toMatch(/^0\.1\.0\+[a-f0-9]{12}$/u)
    expect(await readKingudArtifactIdentity(artifactDir)).toBe(version)
    write(join(artifactDir, 'kingud.js'), 'changed-installed-bytes')
    expect(await readKingudArtifactIdentity(artifactDir)).not.toBe(version)
    expect(artifactDir).toBe(join(fixture.cacheRoot, TARGET, version))
    expect(readFileSync(join(artifactDir, KINGUD_BUILD_TARGET_FILENAME), 'utf8').trim()).toBe(
      TARGET
    )
    for (const filename of kingudArtifactFilenames()) {
      expect(readFileSync(join(artifactDir, filename)).byteLength).toBeGreaterThan(0)
    }
    expect(readFileSync(join(artifactDir, 'agent-browser-linux-x64'), 'utf8')).toBe('browser')
  })

  it('rejects a packaged native file that does not match its manifest', async () => {
    const fixture = createTemplate()
    write(
      join(fixture.templateDir, KINGUD_TEMPLATE_TARGETS_DIR, TARGET, 'watcher.node'),
      'corrupted'
    )

    await expect(
      assembleKingudArtifact({
        templateDir: fixture.templateDir,
        cacheRoot: fixture.cacheRoot,
        target: TARGET,
        runtimePath: fixture.runtimePath
      })
    ).rejects.toThrow('watcher checksum mismatch')
  })

  it('rejects a self-consistent target marker for a different native slot', async () => {
    const fixture = createTemplate()
    const targetPath = join(
      fixture.templateDir,
      KINGUD_TEMPLATE_TARGETS_DIR,
      TARGET,
      KINGUD_BUILD_TARGET_FILENAME
    )
    write(targetPath, 'linux-x64-musl\n')
    const manifestPath = join(fixture.templateDir, KINGUD_TEMPLATE_MANIFEST_FILENAME)
    const manifest = z
      .object({
        targets: z.record(z.string(), z.object({ targetSha256: z.string() }).passthrough())
      })
      .passthrough()
      .parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
    const target = manifest.targets[TARGET]
    if (!target) {
      throw new Error('Missing target fixture')
    }
    target.targetSha256 = sha256(targetPath)
    write(manifestPath, JSON.stringify(manifest))

    await expect(
      assembleKingudArtifact({
        templateDir: fixture.templateDir,
        cacheRoot: fixture.cacheRoot,
        target: TARGET,
        runtimePath: fixture.runtimePath
      })
    ).rejects.toThrow('target identity does not match')
  })

  it('repairs corrupt artifacts beside the old entry and reuses the repair', async () => {
    const fixture = createTemplate()
    const first = await assembleKingudArtifact({
      templateDir: fixture.templateDir,
      cacheRoot: fixture.cacheRoot,
      target: TARGET,
      runtimePath: fixture.runtimePath
    })
    write(join(first, 'kingud.js'), 'corrupted-cache-entry')

    const repaired = await assembleKingudArtifact({ ...fixture, target: TARGET })
    expect(repaired).not.toBe(first)
    expect(readFileSync(join(repaired, 'kingud.js'))).toEqual(
      readFileSync(join(fixture.templateDir, 'kingud.js'))
    )
    expect(await assembleKingudArtifact({ ...fixture, target: TARGET })).toBe(repaired)
    expect(readFileSync(join(first, 'kingud.js'), 'utf8')).toBe('corrupted-cache-entry')
  })

  it('rejects an optional browser without a matching manifest checksum', async () => {
    const fixture = createTemplate()
    const manifestPath = join(fixture.templateDir, KINGUD_TEMPLATE_MANIFEST_FILENAME)
    const manifest = z
      .object({ targets: z.record(z.string(), z.record(z.string(), z.unknown())) })
      .passthrough()
      .parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
    delete manifest.targets[TARGET]?.browserSha256
    write(manifestPath, JSON.stringify(manifest))

    await expect(
      assembleKingudArtifact({
        templateDir: fixture.templateDir,
        cacheRoot: fixture.cacheRoot,
        target: TARGET,
        runtimePath: fixture.runtimePath
      })
    ).rejects.toThrow('browserName and browserSha256')
  })

  it('rejects a manifest that omits a required common artifact checksum', async () => {
    const fixture = createTemplate()
    const manifestPath = join(fixture.templateDir, KINGUD_TEMPLATE_MANIFEST_FILENAME)
    const manifest = z
      .object({ commonSha256: z.record(z.string(), z.string()) })
      .passthrough()
      .parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
    delete manifest.commonSha256['kingud.js']
    write(manifestPath, JSON.stringify(manifest))

    await expect(
      assembleKingudArtifact({
        templateDir: fixture.templateDir,
        cacheRoot: fixture.cacheRoot,
        target: TARGET,
        runtimePath: fixture.runtimePath
      })
    ).rejects.toThrow('manifest omits kingud.js')
  })
})

describe('materializeKingudArtifact cancellation', () => {
  it('detaches either cancelled caller without cancelling their shared cache fill', async () => {
    const fixture = createTemplate()
    let complete: (path: string) => void = () => {}
    vi.mocked(materializeCachedKingudBunRuntime).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve
      })
    )
    const first = new AbortController()
    const second = new AbortController()
    const one = materializeKingudArtifact(TARGET, { ...fixture, signal: first.signal })
    const two = materializeKingudArtifact(TARGET, { ...fixture, signal: second.signal })
    const three = materializeKingudArtifact(TARGET, fixture)
    const firstRejected = expect(one).rejects.toThrow('first cancelled')
    const secondRejected = expect(two).rejects.toThrow('second cancelled')
    await vi.waitFor(() => expect(materializeCachedKingudBunRuntime).toHaveBeenCalledOnce())
    first.abort(new Error('first cancelled'))
    second.abort(new Error('second cancelled'))
    await Promise.all([firstRejected, secondRejected])
    complete(fixture.runtimePath)
    const artifact = await three
    expect(readFileSync(join(artifact, 'kingud.js'), 'utf8')).toBe('kingud-entry')
    expect(materializeCachedKingudBunRuntime).toHaveBeenCalledWith(TARGET, fixture.cacheRoot, {
      fetcher: undefined
    })
  })

  it('refuses an already cancelled request before reading or fetching artifacts', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(materializeKingudArtifact(TARGET, { signal: controller.signal })).rejects.toThrow(
      'cancelled'
    )
    expect(materializeCachedKingudBunRuntime).not.toHaveBeenCalled()
  })
})
