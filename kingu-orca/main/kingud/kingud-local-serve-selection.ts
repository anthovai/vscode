/**
 * Which host runs `kingu serve`: kingud on this machine's packaged slot, or Electron `--serve`.
 * App-side on purpose: the CLI runs it through `kingud-local-serve-selection-entry.ts`, so the
 * CLI bundle never carries the materializers.
 *
 * kingud by default; `KINGU_SERVE_RUNTIME=electron` opts out. Anything that stops kingud from
 * serving this machine (no slot for the target, no pinned Node, a native module it cannot load,
 * a host or packaging path it does not cover yet) falls back to Electron with one stderr line
 * saying why. Everything this writes stays inside the desktop's userData (design D7): the slot
 * under `kingud-artifacts/`, assembled from the template inside the app bundle.
 */
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runProcess } from '@kingu/process-host'
import { NODE_RUNTIME_ASSETS, type ServerTarget } from '../../shared/node-runtime-pin'
import {
  KINGUD_SERVER_ENTRY_FILENAME,
  KINGUD_VERSION_FILENAME,
  kingudNodeRuntimeRelativePath
} from '../../shared/kingud-artifacts'
import {
  KINGUD_NATIVE_PREFLIGHT_FLAG,
  parseKingudNativePreflightReport
} from '../../shared/kingud-native-preflight-report'
import {
  SERVE_RUNTIME_ELECTRON,
  SERVE_RUNTIME_ENV,
  type ServeRuntimeSelection
} from '../../shared/kingud-local-serve-selection'
import { resolveBundledKingudRuntime } from './kingud-bundled-runtime'
import { detectNativeHostAbi, nativeSlotName } from './native-host-abi'
import { materializeKingudArtifact } from './kingud-artifact-materializer'
import { materializeCachedNodeRuntime } from '../node-runtime/pinned-runtime-materializer'
import {
  copyVerifiedAppImageNodeRuntime,
  type AppImageNodeRuntime
} from '../node-runtime/appimage-bundled-node-runtime'
import { serveProfileHasSshTargets } from './serve-profile-ssh-targets'
import { errorMessage } from '../../shared/error-message'

const NATIVE_PREFLIGHT_TIMEOUT_MS = 30_000

export type ServeRuntimeSelectionInput = {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  userDataPath: string
  templateDirs: readonly string[]
  hostTarget?: () => string
  materializeSlot?: typeof materializeKingudArtifact
  materializeRuntime?: typeof materializeCachedNodeRuntime
  /** The pinned Node an AppImage carries; the slot uses it before trying a download. */
  bundledNodeRuntime?: AppImageNodeRuntime | null
  nativePreflight?: (runtime: string, entry: string) => Promise<string>
  profileHasSshTargets?: (userDataPath: string) => boolean
}

function isServerTarget(value: string): value is ServerTarget {
  return Object.keys(NODE_RUNTIME_ASSETS).includes(value)
}

function electron(reason: string): ServeRuntimeSelection {
  return { kind: 'electron', reason }
}

export async function selectServeRuntime(
  input: ServeRuntimeSelectionInput
): Promise<ServeRuntimeSelection> {
  const requested = input.env[SERVE_RUNTIME_ENV]
  if (requested === SERVE_RUNTIME_ELECTRON) {
    return { kind: 'electron', reason: null }
  }
  if (requested && requested !== 'kingud') {
    return electron(`${SERVE_RUNTIME_ENV}=${requested} is neither kingud nor electron`)
  }
  // Why: kingud has no SSH connection stack yet, so a default serve on it would list no targets
  // and fail every connect (#25886, #8489). An explicit KINGU_SERVE_RUNTIME=kingud keeps kingud.
  const sshReason = requested ? null : profileSshReason(input)
  if (sshReason) {
    return electron(sshReason)
  }
  const target = (input.hostTarget ?? (() => nativeSlotName(detectNativeHostAbi())))()
  if (!isServerTarget(target)) {
    return electron(`no kingud build exists for this host (${target})`)
  }
  const templateDir = input.templateDirs.find((candidate) => existsSync(candidate))
  if (!templateDir) {
    return electron('this Kingu install carries no kingud template')
  }
  const cacheRoot = join(input.userDataPath, 'kingud-artifacts')
  let slotDir: string
  try {
    slotDir = await (input.materializeSlot ?? materializeKingudArtifact)(target, {
      templateDir,
      cacheRoot
    })
    await placeSlotRuntime(slotDir, target, cacheRoot, input)
  } catch (error) {
    return electron(`the kingud slot for ${target} could not be prepared: ${errorMessage(error)}`)
  }
  let runtime: string | null
  try {
    runtime = resolveBundledKingudRuntime(slotDir)
  } catch (error) {
    return electron(`the kingud slot is incomplete: ${errorMessage(error)}`)
  }
  if (!runtime) {
    return electron('the kingud slot names no pinned runtime')
  }
  const entry = join(slotDir, KINGUD_SERVER_ENTRY_FILENAME)
  const report = parseKingudNativePreflightReport(
    await (input.nativePreflight ?? runNativePreflight)(runtime, entry).catch(() => '')
  )
  if (!report) {
    return electron('kingud did not answer its native preflight')
  }
  if (report.status === 'blocked' || report.status === 'degraded') {
    return electron(
      `kingud cannot run terminals here (${report.status}: ${report.reason ?? 'unknown'})`
    )
  }
  return {
    kind: 'kingud',
    runtime,
    entry,
    version: readFileSync(join(slotDir, KINGUD_VERSION_FILENAME), 'utf8').trim()
  }
}

/** Why this profile must serve on Electron for SSH, or null when it provably has no targets. */
function profileSshReason(input: ServeRuntimeSelectionInput): string | null {
  try {
    return (input.profileHasSshTargets ?? serveProfileHasSshTargets)(input.userDataPath)
      ? 'this profile has SSH targets, which kingud cannot serve yet'
      : null
  } catch (error) {
    // Why: fail closed. The read-only probe rejects profiles the serve host would still migrate
    // (an older schema), and guessing "no SSH" there leaves saved targets unreachable.
    return `could not tell whether this profile has SSH targets, which kingud cannot serve yet (${errorMessage(error)})`
  }
}

/** The slot references its runtime beside it: the AppImage's own copy, else the cached download. */
async function placeSlotRuntime(
  slotDir: string,
  target: ServerTarget,
  cacheRoot: string,
  {
    materializeRuntime = materializeCachedNodeRuntime,
    bundledNodeRuntime
  }: Pick<ServeRuntimeSelectionInput, 'materializeRuntime' | 'bundledNodeRuntime'>
): Promise<void> {
  const destination = join(
    slotDir,
    ...kingudNodeRuntimeRelativePath(target, NODE_RUNTIME_ASSETS[target].executableSha256)
  )
  if (existsSync(destination)) {
    return
  }
  if (bundledNodeRuntime?.target === target) {
    try {
      await copyVerifiedAppImageNodeRuntime(bundledNodeRuntime, destination)
      return
    } catch (error) {
      console.error(`kingu serve: not using the bundled Node (${errorMessage(error)})`)
    }
  }
  const cached = await materializeRuntime(target, cacheRoot, { fetcher: fetch })
  mkdirSync(dirname(destination), { recursive: true })
  try {
    linkSync(cached, destination)
  } catch {
    copyFileSync(cached, destination)
    chmodSync(destination, 0o755)
  }
}

async function runNativePreflight(runtime: string, entry: string): Promise<string> {
  const result = await runProcess({
    program: runtime,
    args: [entry, KINGUD_NATIVE_PREFLIGHT_FLAG],
    timeoutMs: NATIVE_PREFLIGHT_TIMEOUT_MS
  })
  return result.stdout
}
