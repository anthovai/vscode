import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_RIPGREP_PLATFORMS, bundledRipgrepBinaryName } from './bundled-ripgrep'
import { SERVER_TARGETS } from './node-runtime-pin'
import {
  KINGUD_BUILD_TARGET_FILENAME,
  KINGUD_FOREIGN_SQLITE_READER_ENTRY,
  KINGUD_NODE_PTY_JS_ARTIFACTS,
  KINGUD_NODE_RUNTIME_MARKER_FILENAME,
  KINGUD_RIPGREP_ARTIFACTS,
  KINGUD_RIPGREP_LICENSE_ARTIFACTS,
  KINGUD_WINDOWS_CLI_LAUNCHER_FILENAME,
  KINGUD_WINDOWS_SECURITY_FILENAME,
  kingudArtifactFilenames,
  kingudBunRuntimeFilename,
  kingudNodeRuntimeRelativePath,
  kingudTemplateCommonFilenames,
  kingudTemplateTargetFilenames
} from './kingud-artifacts'

describe('standalone runtime artifacts', () => {
  it.each(SERVER_TARGETS)('ships the native CLI launcher only in Windows %s slots', (target) => {
    expect(kingudArtifactFilenames(target).includes(KINGUD_WINDOWS_CLI_LAUNCHER_FILENAME)).toBe(
      target.startsWith('win32-')
    )
    expect(kingudTemplateCommonFilenames()).not.toContain(KINGUD_WINDOWS_CLI_LAUNCHER_FILENAME)
  })

  it.each(SERVER_TARGETS)(
    'ships the foreign SQLite reader worker the %s runtime starts',
    (target) => {
      expect(kingudArtifactFilenames(target)).toContain(KINGUD_FOREIGN_SQLITE_READER_ENTRY)
    }
  )

  it('names a search binary for every SSH host platform', () => {
    const expected = BUNDLED_RIPGREP_PLATFORMS.map(
      (platform) => `ripgrep/${platform}/${bundledRipgrepBinaryName(platform)}`
    )
    expect(KINGUD_RIPGREP_ARTIFACTS).toEqual(expected)
  })

  it.each(SERVER_TARGETS)('ships only the %s search binary in its install identity', (target) => {
    const [platform, arch] = target.split('-')
    const shipped = kingudArtifactFilenames(target).filter((file) =>
      /^ripgrep\/[^/]+\/rg/.test(file)
    )
    expect(shipped).toEqual([
      `ripgrep/${platform}-${arch}/${bundledRipgrepBinaryName(`${platform}-${arch}`)}`
    ])
  })

  it('ships the binary redistribution notices with every install', () => {
    const sourceDir = join(__dirname, '../../resources/licenses/ripgrep')
    expect(KINGUD_RIPGREP_LICENSE_ARTIFACTS.map((path) => path.split('/').at(-1)).sort()).toEqual(
      readdirSync(sourceDir).sort()
    )
    expect(kingudArtifactFilenames('linux-x64-glibc')).toEqual(
      expect.arrayContaining([...KINGUD_RIPGREP_LICENSE_ARTIFACTS])
    )
  })

  it.each(SERVER_TARGETS)('references the %s runtime instead of carrying a Bun one', (target) => {
    const filenames = kingudArtifactFilenames(target)
    expect(filenames).toContain(KINGUD_NODE_RUNTIME_MARKER_FILENAME)
    expect(filenames).toEqual(expect.arrayContaining(KINGUD_NODE_PTY_JS_ARTIFACTS))
    // A Bun-era selector exits 78 on `.build-target` without its Bun runtime (design D7.1 R5).
    expect(filenames).not.toContain(KINGUD_BUILD_TARGET_FILENAME)
    expect(filenames).not.toContain(kingudBunRuntimeFilename(target))
    expect(filenames.some((file) => file.includes('windows-bun-pty'))).toBe(false)
  })

  it('ships node-pty natives per target, with ConPTY and spawn-helper where they run', () => {
    const natives = (target: string): string[] =>
      kingudArtifactFilenames(target)
        .filter((file) => file.startsWith('node_modules/node-pty/build/Release/'))
        .map((file) => file.slice('node_modules/node-pty/build/Release/'.length))
    expect(natives('linux-arm64-musl')).toEqual(['pty.node'])
    expect(natives('darwin-x64')).toEqual(['pty.node', 'spawn-helper'])
    expect(natives('win32-arm64')).toEqual([
      'conpty.node',
      'conpty_console_list.node',
      'conpty/conpty.dll',
      'conpty/OpenConsole.exe'
    ])
  })

  // Without it kingud's data-root privacy check fails closed and a Windows slot never starts.
  it('requires the Windows security addon in every Windows slot and nowhere else', () => {
    for (const target of ['win32-x64', 'win32-arm64']) {
      expect(kingudArtifactFilenames(target)).toContain(KINGUD_WINDOWS_SECURITY_FILENAME)
      expect(kingudTemplateTargetFilenames(target)).toContain(KINGUD_WINDOWS_SECURITY_FILENAME)
    }
    expect(kingudArtifactFilenames('linux-x64-glibc')).not.toContain(
      KINGUD_WINDOWS_SECURITY_FILENAME
    )
    expect(kingudArtifactFilenames('darwin-arm64')).not.toContain(KINGUD_WINDOWS_SECURITY_FILENAME)
  })

  it('keeps the runtime executable under its upstream name in the shared store', () => {
    expect(kingudNodeRuntimeRelativePath('linux-x64-glibc', 'a'.repeat(64))).toEqual([
      '..',
      'runtimes',
      `node-${'a'.repeat(64)}`,
      'bin',
      'node'
    ])
    expect(kingudNodeRuntimeRelativePath('win32-x64', 'b'.repeat(64)).at(-1)).toBe('node.exe')
  })

  it('keeps target-specific files out of the shared template set', () => {
    const common = kingudTemplateCommonFilenames()
    for (const target of SERVER_TARGETS) {
      expect(common.every((file) => kingudArtifactFilenames(target).includes(file))).toBe(true)
    }
  })
})
