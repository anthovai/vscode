import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { preflightProfileStateRuntime } from '../persistence/profile-state/profile-state-runtime-preflight'
import {
  KINGUD_STARTUP_PREFLIGHT_FLAG,
  KINGUD_PROFILE_PREFLIGHT_TIMEOUT_MS,
  parseKingudProfilePreflight,
  kingudProfilePreflightResponseSchema,
  type KingudProfilePreflightResponse
} from '../../shared/kingud-profile-preflight'
import { readKingudArtifactIdentity } from './kingud-artifact-identity'
import { resolveKingudInstallRoot } from './kingud-app-paths'
import { KINGUD_VERSION_FILENAME, kingudBunRuntimeFilename } from '../../shared/kingud-artifacts'
import { KINGUD_BUN_VERSION } from '../../shared/kingud-bun-runtime'
import { runProcess } from '../../shared/child-process/run-process'
import { preflightKingudBunNativeRuntime } from './kingud-bun-native-preflight'
import { KingudBundledRuntimeError } from './kingud-bundled-runtime'

/** Check every packaged start before a profile index, data-root lock or import is touched. */
export async function preflightBundledKingudStartup(): Promise<void> {
  if (!process.versions.bun) {
    return
  }
  const directory = resolveKingudInstallRoot()
  const identity = await readInstalledVersion(directory)
  const nonce = randomUUID()
  // Keep disposable SQLite ownership and native state out of the serving process.
  const result = await runProcess({
    program: join(directory, kingudBunRuntimeFilename(process.platform)),
    args: [join(directory, 'kingud.js'), KINGUD_STARTUP_PREFLIGHT_FLAG, nonce],
    env: { ...process.env, KINGU_BACKGROUND_LAUNCH: '1' },
    timeoutMs: KINGUD_PROFILE_PREFLIGHT_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    terminationBarrier: true
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    const Failure = result.code === 78 ? KingudBundledRuntimeError : Error
    throw new Failure(`The bundled Kingu runtime failed readiness: ${result.stderr}`)
  }
  try {
    parseKingudProfilePreflight(result.stdout, nonce, KINGUD_BUN_VERSION, identity)
  } catch (cause) {
    throw new KingudBundledRuntimeError('The bundled runtime returned invalid readiness identity', {
      cause
    })
  }
}

/** Only disposable state is opened; no server, profile index or host adapters are installed. */
export async function runKingudProfilePreflight(
  nonce: string | undefined,
  options: { nativeFeatures?: boolean } = {}
): Promise<void> {
  const checkedNonce = z.string().uuid().parse(nonce)
  let artifactVersion: string
  try {
    artifactVersion = await readKingudArtifactIdentity(resolveKingudInstallRoot())
  } catch (cause) {
    throw new KingudBundledRuntimeError('The bundled Kingu artifacts are incomplete or altered', {
      cause
    })
  }
  const result = await preflightProfileStateRuntime()
  if (process.versions.bun) {
    await preflightKingudBunNativeRuntime(options)
  }
  const response: KingudProfilePreflightResponse = {
    type: 'kingu_profile_state_ready',
    nonce: checkedNonce,
    runtime: process.versions.bun ? 'bun' : 'node',
    runtimeVersion: process.versions.bun ?? process.versions.node,
    artifactVersion,
    ...result
  }
  console.log(JSON.stringify(response))
}

async function readInstalledVersion(directory: string): Promise<string> {
  try {
    return kingudProfilePreflightResponseSchema.shape.artifactVersion.parse(
      (await readFile(join(directory, KINGUD_VERSION_FILENAME), 'utf8')).trim()
    )
  } catch (cause) {
    throw new KingudBundledRuntimeError(
      'The installed Kingu artifact version is missing or invalid',
      {
        cause
      }
    )
  }
}
