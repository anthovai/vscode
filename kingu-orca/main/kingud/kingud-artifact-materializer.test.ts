import { createHash } from 'node:crypto'
import type * as NodeFs from 'node:fs'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pruneKingudArtifactCache } from './kingud-artifact-cache-retention'
import { z } from 'zod'
import {
  NODE_RUNTIME_ASSETS,
  NODE_RUNTIME_COMPAT_ASSETS,
  pinnedNodeRuntimeAsset,
  type NodeRuntimeTarget
} from '../../shared/node-runtime-pin'
import {
  KINGUD_BUILD_TARGET_FILENAME,
  KINGUD_NODE_RUNTIME_MARKER_FILENAME,
  KINGUD_SERVER_TARGET_FILENAME,
  KINGUD_TEMPLATE_MANIFEST_FILENAME,
  KINGUD_TEMPLATE_TARGETS_DIR,
  KINGUD_VERSION_FILENAME,
  kingudArtifactFilenames,
  kingudRipgrepArtifact,
  kingudTemplateCommonFilenames,
  kingudTemplateTargetFilenames
} from '../../shared/kingud-artifacts'
import { readKingudArtifactIdentity } from './kingud-artifact-identity'
import { KINGUD_ARTIFACT_VERIFICATION_RECORD_FILENAME } from './kingud-artifact-verification-record'
import {
  getAppEnvironment,
  hasAppEnvironment,
  setAppEnvironment,
  type AppEnvironment
} from '../../shared/app-environment'
import {
  assembleKingudArtifact,
  getKingudTemplateCandidates,
  materializeKingudArtifact,
  resetKingudArtifactMaterializationsForTests
} from './kingud-artifact-materializer'

const TARGET = 'linux-x64-glibc' as const
const fileReads = vi.hoisted(() => ({ count: 0 }))

// Counts whole-file hash reads without changing read behavior.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      fileReads.count += 1
      return actual.createReadStream(...args)
    }
  }
})
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

const ManifestSchema = z
  .object({
    targets: z.record(
      z.string(),
      z.object({ files: z.record(z.string(), z.string()) }).passthrough()
    ),
    commonSha256: z.record(z.string(), z.string())
  })
  .passthrough()

function targetContents(target: NodeRuntimeTarget, filename: string): string {
  if (filename === KINGUD_SERVER_TARGET_FILENAME) {
    return `${target}\n`
  }
  if (filename === KINGUD_NODE_RUNTIME_MARKER_FILENAME) {
    return `${pinnedNodeRuntimeAsset(target).executableSha256}\n`
  }
  return `${target}:${filename}`
}

function createTemplate(target: NodeRuntimeTarget = TARGET): {
  templateDir: string
  cacheRoot: string
} {
  const root = mkdtempSync(join(tmpdir(), 'kingud-artifact-template-'))
  temporaryDirs.push(root)
  const templateDir = join(root, 'template')
  const cacheRoot = join(root, 'cache')
  const commonSha256: Record<string, string> = {}
  for (const filename of kingudTemplateCommonFilenames()) {
    write(join(templateDir, filename), filename === 'kingud.js' ? 'kingud-entry' : filename)
    commonSha256[filename] = sha256(join(templateDir, filename))
  }
  const targetDir = join(templateDir, KINGUD_TEMPLATE_TARGETS_DIR, target)
  const files: Record<string, string> = {}
  for (const filename of kingudTemplateTargetFilenames(target)) {
    write(join(targetDir, filename), targetContents(target, filename))
    files[filename] = sha256(join(targetDir, filename))
  }
  write(join(targetDir, 'agent-browser-linux-x64'), 'browser')
  write(
    join(templateDir, KINGUD_TEMPLATE_MANIFEST_FILENAME),
    JSON.stringify({
      schemaVersion: 3,
      commonSha256,
      targets: {
        [target]: {
          files,
          browserName: 'agent-browser-linux-x64',
          browserSha256: sha256(join(targetDir, 'agent-browser-linux-x64'))
        }
      }
    })
  )
  return { templateDir, cacheRoot }
}

function rewriteManifest(
  templateDir: string,
  change: (manifest: z.infer<typeof ManifestSchema>) => void
): void {
  const manifestPath = join(templateDir, KINGUD_TEMPLATE_MANIFEST_FILENAME)
  const manifest = ManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
  change(manifest)
  write(manifestPath, JSON.stringify(manifest))
}

describe('assembleKingudArtifact', () => {
  it('reuses the same version from cache after retention evicts other versions', async () => {
    const fixture = createTemplate()
    const first = await assembleKingudArtifact({ ...fixture, target: TARGET })
    const entry = statSync(join(first, 'kingud.js'))
    // Older versions of the same target, used before this one.
    const older = [1, 2, 3].map((age) => {
      const dir = join(fixture.cacheRoot, TARGET, `0.0.${age}+old`)
      write(join(dir, 'kingud.js'), 'old')
      const at = new Date(Date.now() - age * 60_000)
      utimesSync(dir, at, at)
      return dir
    })
    const removed = await pruneKingudArtifactCache(fixture.cacheRoot, {
      inUseVersions: new Set([basename(first)])
    })

    expect(removed).toEqual([older[2]])
    const second = await assembleKingudArtifact({ ...fixture, target: TARGET })
    expect(second).toBe(first)
    // A verified hit: the same files, not a re-copy.
    expect(statSync(join(second, 'kingud.js')).ino).toBe(entry.ino)
  })

  it.skipIf(process.platform === 'win32')(
    'restores executable modes from a template copied without them',
    async () => {
      const target = 'darwin-arm64' as const
      const fixture = createTemplate(target)
      const executables = [
        kingudRipgrepArtifact(target),
        'node_modules/node-pty/build/Release/spawn-helper'
      ]
      for (const filename of executables) {
        chmodSync(join(fixture.templateDir, KINGUD_TEMPLATE_TARGETS_DIR, target, filename), 0o644)
      }
      const artifactDir = await assembleKingudArtifact({ ...fixture, target })
      for (const filename of executables) {
        expect(statSync(join(artifactDir, filename)).mode & 0o777).toBe(0o755)
      }
    }
  )

  it('assembles the rung B compat slot against the compat runtime', async () => {
    const target = 'linux-x64-glibc217' as const
    const fixture = createTemplate(target)
    const artifactDir = await assembleKingudArtifact({ ...fixture, target })

    expect(
      readFileSync(join(artifactDir, KINGUD_NODE_RUNTIME_MARKER_FILENAME), 'utf8').trim()
    ).toBe(NODE_RUNTIME_COMPAT_ASSETS[target].executableSha256)
    expect(
      readFileSync(join(artifactDir, 'node_modules/node-pty/build/Release/pty.node'), 'utf8')
    ).toBe(`${target}:node_modules/node-pty/build/Release/pty.node`)
    // The host-side preflight hashes it the same way, so managed kingud can run it.
    expect(await readKingudArtifactIdentity(artifactDir)).toBe(
      readFileSync(join(artifactDir, KINGUD_VERSION_FILENAME), 'utf8').trim()
    )
  })

  it('refuses a compat slot that names the default runtime', async () => {
    const target = 'linux-x64-glibc217' as const
    const fixture = createTemplate(target)
    const marker = join(
      fixture.templateDir,
      KINGUD_TEMPLATE_TARGETS_DIR,
      target,
      KINGUD_NODE_RUNTIME_MARKER_FILENAME
    )
    write(marker, `${NODE_RUNTIME_ASSETS['linux-x64-glibc'].executableSha256}\n`)
    rewriteManifest(fixture.templateDir, (manifest) => {
      const entry = manifest.targets[target]
      if (entry) {
        entry.files[KINGUD_NODE_RUNTIME_MARKER_FILENAME] = sha256(marker)
      }
    })
    await expect(assembleKingudArtifact({ ...fixture, target })).rejects.toThrow(
      'does not reference the pinned Node'
    )
  })

  it('assembles a complete content-addressed slot that references the pinned Node', async () => {
    const fixture = createTemplate()
    const artifactDir = await assembleKingudArtifact({ ...fixture, target: TARGET })

    const version = readFileSync(join(artifactDir, KINGUD_VERSION_FILENAME), 'utf8').trim()
    expect(version).toMatch(/^0\.1\.0\+[a-f0-9]{12}$/u)
    expect(await readKingudArtifactIdentity(artifactDir)).toBe(version)
    write(join(artifactDir, 'kingud.js'), 'changed-installed-bytes')
    expect(await readKingudArtifactIdentity(artifactDir)).not.toBe(version)
    expect(artifactDir).toBe(join(fixture.cacheRoot, TARGET, version))
    expect(readFileSync(join(artifactDir, KINGUD_SERVER_TARGET_FILENAME), 'utf8').trim()).toBe(
      TARGET
    )
    expect(
      readFileSync(join(artifactDir, KINGUD_NODE_RUNTIME_MARKER_FILENAME), 'utf8').trim()
    ).toBe(NODE_RUNTIME_ASSETS[TARGET].executableSha256)
    for (const filename of kingudArtifactFilenames(TARGET)) {
      expect(readFileSync(join(artifactDir, filename)).byteLength).toBeGreaterThan(0)
    }
    // A Bun-era client's selector would exit 78 on this file without a Bun runtime (R5).
    expect(() => readFileSync(join(artifactDir, KINGUD_BUILD_TARGET_FILENAME))).toThrow()
    expect(readFileSync(join(artifactDir, 'agent-browser-linux-x64'), 'utf8')).toBe('browser')
  })

  it('rejects a packaged native file that does not match its manifest', async () => {
    const fixture = createTemplate()
    write(
      join(
        fixture.templateDir,
        KINGUD_TEMPLATE_TARGETS_DIR,
        TARGET,
        'node_modules/node-pty/build/Release/pty.node'
      ),
      'corrupted'
    )

    await expect(assembleKingudArtifact({ ...fixture, target: TARGET })).rejects.toThrow(
      'node_modules/node-pty/build/Release/pty.node checksum mismatch'
    )
  })

  it('rejects a self-consistent target marker for a different native slot', async () => {
    const fixture = createTemplate()
    const targetPath = join(
      fixture.templateDir,
      KINGUD_TEMPLATE_TARGETS_DIR,
      TARGET,
      KINGUD_SERVER_TARGET_FILENAME
    )
    write(targetPath, 'linux-x64-musl\n')
    rewriteManifest(fixture.templateDir, (manifest) => {
      manifest.targets[TARGET]!.files[KINGUD_SERVER_TARGET_FILENAME] = sha256(targetPath)
    })

    await expect(assembleKingudArtifact({ ...fixture, target: TARGET })).rejects.toThrow(
      'target identity does not match'
    )
  })

  it('rejects a self-consistent runtime reference to another Node', async () => {
    const fixture = createTemplate()
    const markerPath = join(
      fixture.templateDir,
      KINGUD_TEMPLATE_TARGETS_DIR,
      TARGET,
      KINGUD_NODE_RUNTIME_MARKER_FILENAME
    )
    write(markerPath, `${'0'.repeat(64)}\n`)
    rewriteManifest(fixture.templateDir, (manifest) => {
      manifest.targets[TARGET]!.files[KINGUD_NODE_RUNTIME_MARKER_FILENAME] = sha256(markerPath)
    })

    await expect(assembleKingudArtifact({ ...fixture, target: TARGET })).rejects.toThrow(
      'does not reference the pinned Node'
    )
  })

  it('repairs corrupt artifacts beside the old entry and reuses the repair', async () => {
    const fixture = createTemplate()
    const first = await assembleKingudArtifact({ ...fixture, target: TARGET })
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
    rewriteManifest(fixture.templateDir, (manifest) => {
      delete manifest.targets[TARGET]?.browserSha256
    })

    await expect(assembleKingudArtifact({ ...fixture, target: TARGET })).rejects.toThrow(
      'browserName and browserSha256'
    )
  })

  // Regression: a browser digest keyed like kingud.js must not replace the common digest.
  it('rejects a browser named like a required slot file', async () => {
    const fixture = createTemplate()
    rewriteManifest(fixture.templateDir, (manifest) => {
      manifest.targets[TARGET]!.browserName = 'kingud.js'
    })

    await expect(assembleKingudArtifact({ ...fixture, target: TARGET })).rejects.toThrow(
      'browser name collides with a slot file'
    )
  })

  it('rejects a manifest that omits a required common artifact checksum', async () => {
    const fixture = createTemplate()
    rewriteManifest(fixture.templateDir, (manifest) => {
      delete manifest.commonSha256['kingud.js']
    })

    await expect(assembleKingudArtifact({ ...fixture, target: TARGET })).rejects.toThrow(
      'manifest omits kingud.js'
    )
  })
})

describe('assembleKingudArtifact verification record', () => {
  // Every fixture file was written this instant; a later clock makes their signatures settled.
  const later = (): number => Date.now() + 60_000
  const recordPath = (cacheRoot: string): string =>
    join(cacheRoot, TARGET, KINGUD_ARTIFACT_VERIFICATION_RECORD_FILENAME)

  async function assembleUntilSlotRecorded(fixture: {
    templateDir: string
    cacheRoot: string
  }): Promise<string> {
    // The first call copies a fresh slot; the second hashes it once and records it.
    const first = await assembleKingudArtifact({
      ...fixture,
      target: TARGET,
      now: later,
      trustVerificationRecord: true
    })
    expect(
      await assembleKingudArtifact({
        ...fixture,
        target: TARGET,
        now: later,
        trustVerificationRecord: true
      })
    ).toBe(first)
    return first
  }

  // Regression: SSH and local serve keep hashing every launch; a forged record must not bypass it.
  it('neither reads nor writes a record unless the caller trusts it', async () => {
    const fixture = createTemplate()
    const slot = await assembleUntilSlotRecorded(fixture)
    const recorded = readFileSync(recordPath(fixture.cacheRoot), 'utf8')
    const before = fileReads.count
    expect(await assembleKingudArtifact({ ...fixture, target: TARGET, now: later })).toBe(slot)
    // Template pass plus the slot's own check, exactly as with no record at all.
    expect(fileReads.count - before).toBe((kingudArtifactFilenames(TARGET).length + 1) * 2)
    rmSync(recordPath(fixture.cacheRoot))
    await assembleKingudArtifact({ ...fixture, target: TARGET, now: later })
    expect(existsSync(recordPath(fixture.cacheRoot))).toBe(false)
    expect(recorded.length).toBeGreaterThan(0)
  })

  it('records nothing while the files may still change under the same timestamps', async () => {
    const fixture = createTemplate()
    await assembleKingudArtifact({ ...fixture, target: TARGET, trustVerificationRecord: true })
    expect(existsSync(recordPath(fixture.cacheRoot))).toBe(false)
  })

  it('reuses recorded digests without reading the template or the slot again', async () => {
    const fixture = createTemplate()
    const slot = await assembleUntilSlotRecorded(fixture)
    const before = fileReads.count
    expect(
      await assembleKingudArtifact({
        ...fixture,
        target: TARGET,
        now: later,
        trustVerificationRecord: true
      })
    ).toBe(slot)
    expect(fileReads.count).toBe(before)
  })

  it('hashes the template once per launch when nothing is recorded', async () => {
    const fixture = createTemplate()
    const before = fileReads.count
    const slot = await assembleKingudArtifact({ ...fixture, target: TARGET })
    const sources = kingudArtifactFilenames(TARGET).length + 1
    // One template pass plus the copied slot's own check, where three template passes ran before.
    expect(fileReads.count - before).toBe(sources * 2)
    expect(slot).toContain(fixture.cacheRoot)
  })

  it('hashes again when a template file is rewritten in place at the same size', async () => {
    const fixture = createTemplate()
    await assembleUntilSlotRecorded(fixture)
    const templateEntry = join(fixture.templateDir, 'kingud.js')
    writeFileSync(templateEntry, 'kingud-ENTRY')

    await expect(
      assembleKingudArtifact({
        ...fixture,
        target: TARGET,
        now: later,
        trustVerificationRecord: true
      })
    ).rejects.toThrow('kingud template kingud.js checksum mismatch')
  })

  it('hashes again when the manifest no longer lists the recorded digest', async () => {
    const fixture = createTemplate()
    await assembleUntilSlotRecorded(fixture)
    rewriteManifest(fixture.templateDir, (manifest) => {
      manifest.commonSha256['kingud.js'] = 'f'.repeat(64)
    })

    await expect(
      assembleKingudArtifact({
        ...fixture,
        target: TARGET,
        now: later,
        trustVerificationRecord: true
      })
    ).rejects.toThrow('kingud template kingud.js checksum mismatch')
  })

  it('repairs a recorded slot whose file was rewritten in place at the same size', async () => {
    const fixture = createTemplate()
    const slot = await assembleUntilSlotRecorded(fixture)
    writeFileSync(join(slot, 'kingud.js'), 'kingud-ENTRY')

    const repaired = await assembleKingudArtifact({
      ...fixture,
      target: TARGET,
      now: later,
      trustVerificationRecord: true
    })
    expect(repaired).toBe(`${slot}.repair-1`)
    expect(readFileSync(join(repaired, 'kingud.js'), 'utf8')).toBe('kingud-entry')
  })

  it('ignores an unreadable record and hashes as before', async () => {
    const fixture = createTemplate()
    const slot = await assembleUntilSlotRecorded(fixture)
    writeFileSync(recordPath(fixture.cacheRoot), '{"version":1,')

    expect(
      await assembleKingudArtifact({
        ...fixture,
        target: TARGET,
        now: later,
        trustVerificationRecord: true
      })
    ).toBe(slot)
  })
})

describe('materializeKingudArtifact cancellation', () => {
  it('detaches a cancelled caller without cancelling the shared cache fill', async () => {
    const fixture = createTemplate()
    const first = new AbortController()
    const one = materializeKingudArtifact(TARGET, { ...fixture, signal: first.signal })
    const two = materializeKingudArtifact(TARGET, fixture)
    first.abort(new Error('first cancelled'))
    await expect(one).rejects.toThrow('first cancelled')
    const artifact = await two
    expect(readFileSync(join(artifact, 'kingud.js'), 'utf8')).toBe('kingud-entry')
  })

  it('refuses an already cancelled request before reading artifacts', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(materializeKingudArtifact(TARGET, { signal: controller.signal })).rejects.toThrow(
      'cancelled'
    )
  })
})

describe('packaged template lookup', () => {
  const originalResourcesPath = process.resourcesPath
  const originalTemplatePath = process.env.KINGU_KINGUD_TEMPLATE_PATH
  let previousEnvironment: AppEnvironment | null = null

  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      configurable: true,
      writable: true
    })
    if (originalTemplatePath === undefined) {
      delete process.env.KINGU_KINGUD_TEMPLATE_PATH
    } else {
      process.env.KINGU_KINGUD_TEMPLATE_PATH = originalTemplatePath
    }
    if (previousEnvironment) {
      setAppEnvironment(previousEnvironment)
    }
  })

  /** An installed app: electron-builder copies out/kingud-template to Resources/kingud-template. */
  function installPackagedApp(): { resourcesDir: string; userData: string } {
    const fixture = createTemplate()
    const root = dirname(fixture.templateDir)
    const resourcesDir = join(root, 'Resources')
    mkdirSync(resourcesDir)
    renameSync(fixture.templateDir, join(resourcesDir, 'kingud-template'))
    const userData = join(root, 'userData')
    delete process.env.KINGU_KINGUD_TEMPLATE_PATH
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesDir,
      configurable: true,
      writable: true
    })
    previousEnvironment = hasAppEnvironment() ? getAppEnvironment() : null
    setAppEnvironment({
      getPath: () => userData,
      getAppPath: () => join(resourcesDir, 'app.asar'),
      getVersion: () => '0.0.0-test',
      isPackaged: () => true,
      onWillQuit: () => {},
      exit: () => {},
      getAppMetrics: () => []
    })
    return { resourcesDir, userData }
  }

  it('materializes from Resources/kingud-template into userData with no explicit paths', async () => {
    const { resourcesDir, userData } = installPackagedApp()

    expect(getKingudTemplateCandidates()[0]).toBe(join(resourcesDir, 'kingud-template'))
    const artifact = await materializeKingudArtifact(TARGET)
    expect(dirname(dirname(artifact))).toBe(join(userData, 'kingud-artifacts'))
    expect(readFileSync(join(artifact, 'kingud.js'), 'utf8')).toBe('kingud-entry')
  })

  it('reports a build that shipped no template, which relays treat as a legacy fallback', async () => {
    const { resourcesDir } = installPackagedApp()
    rmSync(join(resourcesDir, 'kingud-template'), { recursive: true })

    await expect(materializeKingudArtifact(TARGET)).rejects.toThrow(
      'The packaged kingud deployment template is missing'
    )
  })
})
