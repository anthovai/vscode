/**
 * What a packaged `kingud` directory must contain, declared once — the same single-source
 * treatment `relay-artifacts.ts` gives the relay, for the same reason: the build, the
 * content hash and the remote install probe must not keep three lists that drift.
 *
 * Order is load-bearing: the hash concatenates these files in sequence.
 *
 * Keep this file erasable-only TypeScript — build-kingud.mjs imports it directly under
 * Node's type stripping, which rejects enums, namespaces and parameter properties.
 */
export const KINGUD_BUN_RUNTIME_FILENAME = 'bun-runtime'
export const KINGUD_WINDOWS_BUN_RUNTIME_FILENAME = 'bun-runtime.exe'
export const KINGUD_WINDOWS_PROCESS_TREE_FILENAME = 'windows-process-tree.node'

export function kingudBunRuntimeFilename(target: string): string {
  return target === 'win32' || target.startsWith('win32-')
    ? KINGUD_WINDOWS_BUN_RUNTIME_FILENAME
    : KINGUD_BUN_RUNTIME_FILENAME
}

/** Keep renamed Windows executables in a new content-addressed slot. */
export function kingudArtifactHashPrefix(target: string): string {
  return kingudBunRuntimeFilename(target) === KINGUD_WINDOWS_BUN_RUNTIME_FILENAME
    ? `${KINGUD_WINDOWS_BUN_RUNTIME_FILENAME}\0`
    : ''
}
export const KINGUD_BUILD_TARGET_FILENAME = '.build-target'
export const KINGUD_PARCEL_WATCHER_ENTRY = 'node_modules/@parcel/watcher/index.js'
export const KINGUD_PARCEL_WATCHER_NATIVE = 'node_modules/@parcel/watcher/watcher.node'
export const KINGUD_EMOJI_SHORTCODE_DATASET =
  'node_modules/emojibase-data/en/shortcodes/emojibase.json'

export const KINGUD_VERSION = '0.1.0'

// Kept here because build-kingud.mjs imports this manifest directly under Node type stripping.
export const KINGUD_RIPGREP_ARTIFACTS = [
  'ripgrep/linux-x64/rg',
  'ripgrep/linux-arm64/rg',
  'ripgrep/darwin-x64/rg',
  'ripgrep/darwin-arm64/rg',
  'ripgrep/win32-x64/rg.exe',
  'ripgrep/win32-arm64/rg.exe'
] as const

export const KINGUD_RIPGREP_LICENSE_ARTIFACTS = [
  'ripgrep/licenses/JEMALLOC-COPYING',
  'ripgrep/licenses/LICENSE-MIT',
  'ripgrep/licenses/LLVM-LIBUNWIND-LICENSE.TXT',
  'ripgrep/licenses/MUSL-COPYRIGHT',
  'ripgrep/licenses/PCRE2-LICENCE.md',
  'ripgrep/licenses/README.md',
  'ripgrep/licenses/RUST-CRATE-NOTICES.txt',
  'ripgrep/licenses/SLJIT-LICENSE',
  'ripgrep/licenses/UNLICENSE'
] as const

export type KingudArtifact = {
  filename: string
  /**
   * Absence is a degradation, not a torn install, so the remote probe must not require it.
   * The agent-browser binary is the only one: `resolveKingudBrowserProvider` already answers
   * "no headless browser" when it is missing, and it is named per platform-arch anyway.
   */
  optional?: boolean
}

export const KINGUD_ARTIFACTS: readonly KingudArtifact[] = [
  { filename: 'kingud.js' },
  // Forked so a native @parcel/watcher fault kills the child, not the server.
  { filename: 'parcel-watcher-process-entry.js' },
  // Forked so PTYs outlive the runtime process; its absence makes every restart destructive.
  { filename: 'daemon-entry.js' },
  { filename: 'windows-bun-pty-gate-entry.js' },
  { filename: 'profile-state-writer-worker-entry.js' },
  { filename: 'profile-state-backup-worker-entry.js' },
  // Target-specific even when the JavaScript bundle is shared across packaged slots.
  { filename: KINGUD_BUILD_TARGET_FILENAME },
  // kingud never depends on a host runtime or host-installed native module.
  { filename: KINGUD_BUN_RUNTIME_FILENAME },
  { filename: KINGUD_PARCEL_WATCHER_ENTRY },
  { filename: KINGUD_PARCEL_WATCHER_NATIVE },
  { filename: KINGUD_EMOJI_SHORTCODE_DATASET },
  ...KINGUD_RIPGREP_ARTIFACTS.map((filename) => ({ filename })),
  ...KINGUD_RIPGREP_LICENSE_ARTIFACTS.map((filename) => ({ filename }))
]

/** Written after the artifacts, so it is never an input to its own hash. */
export const KINGUD_VERSION_FILENAME = '.version'
export const KINGUD_TEMPLATE_MANIFEST_FILENAME = 'kingud-template.json'
export const KINGUD_TEMPLATE_TARGETS_DIR = 'targets'

/** Written last by the installer; its absence means a torn install. */
export const KINGUD_INSTALL_COMPLETE_FILENAME = '.install-complete'

export function kingudArtifactFilenames(target = ''): string[] {
  const filenames = KINGUD_ARTIFACTS.filter((artifact) => !artifact.optional).map((artifact) =>
    artifact.filename === KINGUD_BUN_RUNTIME_FILENAME
      ? kingudBunRuntimeFilename(target)
      : artifact.filename
  )
  if (target === 'win32' || target.startsWith('win32-')) {
    filenames.push(KINGUD_WINDOWS_PROCESS_TREE_FILENAME)
  }
  return filenames
}

export function kingudTemplateCommonFilenames(): string[] {
  return kingudArtifactFilenames().filter(
    (filename) =>
      filename !== KINGUD_BUN_RUNTIME_FILENAME &&
      filename !== KINGUD_BUILD_TARGET_FILENAME &&
      filename !== KINGUD_PARCEL_WATCHER_NATIVE
  )
}
