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
import { KINGUD_EXIT_CONFIGURATION } from './kingud-configuration-exit'
import {
  KINGUD_SERVER_ENTRY_FILENAME,
  KINGUD_VERSION_FILENAME
} from '../../shared/kingud-artifacts'
import { KINGUD_NODE_RUNTIME_IDENTITY } from '../../shared/kingud-node-runtime-identity'
import { runProcess } from '@kingu/process-host'
import { preflightKingudNativeRuntime } from './kingud-runtime-native-preflight'
import { kingudCompileCacheEnv } from './kingud-compile-cache'
import {
  isRunningAsBundledKingudRuntime,
  KingudBundledRuntimeError,
  resolveBundledKingudSlot
} from './kingud-bundled-runtime'

/** Check every packaged start before a profile index, data-root lock or import is touched. */
export async function preflightBundledKingudStartup(): Promise<void> {
  const directory = resolveBundledKingudSlot()
  if (!isRunningAsBundledKingudRuntime(directory)) {
    return
  }
  const identity = await readInstalledVersion(directory)
  const nonce = randomUUID()
  // Keep disposable SQLite ownership and native state out of the serving process.
  const result = await runProcess({
    program: process.execPath,
    args: [join(directory, KINGUD_SERVER_ENTRY_FILENAME), KINGUD_STARTUP_PREFLIGHT_FLAG, nonce],
    // The preflight compiles the same bundle again, so it shares the server's code cache.
    env: { ...process.env, KINGU_BACKGROUND_LAUNCH: '1', ...kingudCompileCacheEnv(directory) },
    timeoutMs: KINGUD_PROFILE_PREFLIGHT_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    terminationBarrier: true
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    const Failure = result.code === KINGUD_EXIT_CONFIGURATION ? KingudBundledRuntimeError : Error
    throw new Failure(`The bundled Kingu runtime failed readiness: ${result.stderr}`)
  }
  try {
    parseKingudProfilePreflight(result.stdout, nonce, KINGUD_NODE_RUNTIME_IDENTITY, identity)
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
  const directory = resolveBundledKingudSlot()
  let artifactVersion: string
  try {
    artifactVersion = await readKingudArtifactIdentity(directory)
  } catch (cause) {
    throw new KingudBundledRuntimeError('The bundled Kingu artifacts are incomplete or altered', {
      cause
    })
  }
  const result = await preflightProfileStateRuntime()
  // Why only inside the pinned runtime: a host Node rollback launcher never serves this slot.
  if (isRunningAsBundledKingudRuntime(directory)) {
    await preflightKingudNativeRuntime(options)
  }
  const response: KingudProfilePreflightResponse = {
    type: 'kingu_profile_state_ready',
    nonce: checkedNonce,
    runtime: 'node',
    runtimeVersion: process.versions.node,
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
