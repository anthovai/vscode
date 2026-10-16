import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import { startKingudBrowserProvider } from './kingud-browser-startup'
import { KingudRuntimeLifetime, type KingudRuntimeCleanup } from './kingud-runtime-lifetime'
import type { KingudManagedStopInstance } from '../../shared/kingud-stop-request'
import { acquireKingudInstanceLock } from './kingud-instance-lock'
import { KINGUD_BUNDLED_LAUNCHER_ENV } from './kingud-bundled-runtime'
import { resolveKingudExitCode } from './kingud-exit-code'
import { recordAgentSessionRuntimeEnd } from '../runtime/agent-session-runtime-end-record'
import { KINGUD_SHUTDOWN_DEADLINE_MS } from './kingud-stop-deadlines'
import {
  acquireProfileStateRuntimeAdmission,
  type ProfileStateRuntimeAdmission
} from '../persistence/profile-state/profile-state-access'

const bundledLauncherChannel = process.env[KINGUD_BUNDLED_LAUNCHER_ENV] === '1'
delete process.env[KINGUD_BUNDLED_LAUNCHER_ENV]

function createIdempotentKingudCleanup(cleanup: () => Promise<void>): () => Promise<void> {
  let completion: Promise<void> | null = null
  return () => {
    completion ??= Promise.resolve().then(cleanup)
    return completion
  }
}

export { KINGUD_SHUTDOWN_DEADLINE_MS }

/** True when this call began the stop; false when another source already owns it. */
export type KingudShutdownTrigger = (reason: string, onFailed?: () => void) => boolean

/**
 * A launcher and its child can both receive the same process-group or service stop signal.
 * Returns the trigger stop-request listeners share, so every source runs one bounded stop.
 * `onFailed` runs before a failed or overdue stop exits, so a caller can retract a clean record.
 */
export function installKingudShutdownSignals(
  stop: () => Promise<void>,
  deadlineMs = KINGUD_SHUTDOWN_DEADLINE_MS
): KingudShutdownTrigger {
  let stopping = false
  const shutdown: KingudShutdownTrigger = (signal, onFailed) => {
    if (stopping) {
      return false
    }
    stopping = true
    setTimeout(() => {
      console.error(`kingud: shutdown after ${signal} exceeded ${deadlineMs}ms — exiting`)
      onFailed?.()
      process.exit(1)
    }, deadlineMs)
    stop()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(`kingud: shutdown after ${signal} failed:`, error)
        onFailed?.()
        process.exit(resolveKingudExitCode(error))
      })
    return true
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  // Headless runtimes survive terminal hangups; INT/TERM are the graceful stop contract.
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => {})
  }
  if (bundledLauncherChannel && typeof process.send === 'function') {
    process.once('disconnect', () => shutdown('launcher disconnect'))
    if (!process.connected) {
      shutdown('launcher disconnect')
    }
  }
  return shutdown
}

export async function startKingudWithLifecycle<T extends object>(
  start: (registerRuntimeCleanup: (cleanup: KingudRuntimeCleanup) => void) => Promise<T>,
  cleanupHost: (runtimeCleanupSucceeded: boolean) => Promise<void>
): Promise<T & { stop(): Promise<void> }> {
  // Runtime resources stop in reverse registration order before any host resource.
  const runtime = new KingudRuntimeLifetime()
  const cleanup = createIdempotentKingudCleanup(async () => {
    // First, before any wait: chats whose agent dies with this stop read as a restart, not a crash.
    recordAgentSessionRuntimeEnd('quit')
    let runtimeCleanupSucceeded = false
    try {
      await runtime.stop()
      runtimeCleanupSucceeded = true
    } finally {
      await cleanupHost(runtimeCleanupSucceeded)
    }
  })
  try {
    const handle = await start((nextCleanup) => runtime.add(nextCleanup))
    return { ...handle, stop: cleanup }
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      // Keep the launch failure as the supervisor-facing verdict; cleanup still needs a breadcrumb.
      console.error('[kingud] startup cleanup failed:', cleanupError)
    }
    throw error
  }
}

/** Keep profile admission and the instance lock until every runtime writer has stopped. */
export async function startKingudWithHost<T extends object>(
  userDataPath: string,
  start: (registerCleanup: (cleanup: KingudRuntimeCleanup) => void) => Promise<T>,
  runQuitHandlers: () => void
): Promise<T & { stop(): Promise<void>; instance: KingudManagedStopInstance }> {
  const instanceLock = acquireKingudInstanceLock(userDataPath)
  const { pid, startedAtMs, nonce } = instanceLock.record
  const instance = { pid, startedAtMs, nonce, lockPath: instanceLock.path }
  let admission: ProfileStateRuntimeAdmission | undefined
  let browserProvider: ReturnType<typeof startKingudBrowserProvider> | undefined
  return startKingudWithLifecycle(
    async (registerCleanup) => {
      admission = acquireProfileStateRuntimeAdmission(userDataPath)
      // Why not awaited: a desktop sidecar's authorization UI must not hold RPC readiness hostage.
      browserProvider = startKingudBrowserProvider({ userDataPath })
      return { ...(await start(registerCleanup)), instance }
    },
    async (runtimeCleanupSucceeded) => {
      // Failed teardown keeps both fences until the process actually exits.
      const host = new KingudRuntimeLifetime(() => {
        if (runtimeCleanupSucceeded) {
          instanceLock.release()
        }
      })
      host.add(({ failed }) => {
        if (runtimeCleanupSucceeded && !failed) {
          admission?.release()
        }
      })
      host.add(() => runQuitHandlers())
      host.add(() => setRuntimeBrowserCommandsFactory(null))
      host.add(() => browserProvider?.stop())
      await host.stop()
    }
  )
}

export async function flushKingudProfileStoreForShutdown(store: {
  flushFinalOrThrowAsync(): Promise<void>
  freezeWritesAsync(): Promise<void>
}): Promise<void> {
  try {
    await store.flushFinalOrThrowAsync()
  } finally {
    await store.freezeWritesAsync()
  }
}
