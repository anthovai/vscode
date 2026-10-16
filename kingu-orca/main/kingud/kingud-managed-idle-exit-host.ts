/** Binds managed idle exit to this kingud's RPC server, PTY provider and terminal daemon. */
import { getAppEnvironment } from '../../shared/app-environment'
import type { RuntimeRpcClientActivity } from '../runtime/runtime-rpc/runtime-rpc-shutdown'
import type { KingudIdleExitEvidence } from './kingud-idle-exit-monitor'
import {
  activationFenceExists,
  installKingudManagedIdleExit,
  resolveKingudManagedIdleExit,
  type KingudManagedIdleExitConfig
} from './kingud-managed-idle-exit'
import {
  consumeKingudIdleStopRecord,
  discardKingudIdleStopRecord,
  writeKingudIdleStopRecord
} from './kingud-idle-stop-record'
import type { KingudShutdownTrigger } from './kingud-lifecycle'
import type { KingudIdleStopRecord } from '../../shared/kingud-idle-exit'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

let requestIdleShutdown: KingudShutdownTrigger | null = null

/** main binds its shutdown once signal handling exists; the quiet period outlasts that gap. */
export function bindKingudIdleShutdown(request: KingudShutdownTrigger): void {
  requestIdleShutdown = request
}

type KingudIdleExitRuntimePorts = {
  rpc: { readClientActivity(): RuntimeRpcClientActivity }
  agentStates: () => readonly { state: string }[]
  hasStagedMigration: () => boolean
  automationsBusy: () => boolean
  /** Shutdown stops the monitor first, so a signal stop is never recorded as an idle one. */
  registerCleanup: (cleanup: () => void) => void
}

/**
 * Runs under the instance lock at startup: reads the previous run's idle-stop record before
 * anything this run does could be mistaken for it. Inert for an kingud no client launched.
 */
export function beginKingudIdleExit(userDataPath: string): {
  previousIdleStop: KingudIdleStopRecord | null | undefined
  start: (ports: KingudIdleExitRuntimePorts) => Promise<void>
} {
  const config = resolveKingudManagedIdleExit(process.env)
  if (!config) {
    return { previousIdleStop: undefined, start: async () => {} }
  }
  const previousIdleStop = consumeKingudIdleStopRecord(userDataPath)
  if (previousIdleStop) {
    console.error(`[kingud] the previous run stopped idle at ${previousIdleStop.stoppedAt}`)
  }
  const version = getAppEnvironment().getVersion()
  return {
    previousIdleStop,
    start: (ports) => startKingudManagedIdleExit({ ...ports, config, userDataPath, version })
  }
}

async function startKingudManagedIdleExit(
  input: KingudIdleExitRuntimePorts & {
    config: KingudManagedIdleExitConfig
    userDataPath: string
    version: string
  }
): Promise<void> {
  const { getLocalPtyProvider } = await import('../ipc/pty/provider/registry')
  const { getDaemonEndpointFacts } = await import('../daemon/daemon-provider-state')
  const { countLiveKingudDaemonSessions, retireKingudDaemonIfIdle } =
    await import('./kingud-daemon-retirement')
  const idleRecord = createIdleStopRecordOwnership(input.userDataPath)
  const hasChatProviders = (): boolean =>
    getStructuredAgentSessionHost()?.hasLoadedProviders() ?? false
  const dispose = installKingudManagedIdleExit({
    config: input.config,
    ports: {
      readClientActivity: () => input.rpc.readClientActivity(),
      listTerminals: () => getLocalPtyProvider().listProcesses(),
      countDaemonSessions: countLiveKingudDaemonSessions,
      hasDaemon: () => getDaemonEndpointFacts() !== null,
      agentStates: input.agentStates,
      hasChatProviders,
      hasStagedMigration: input.hasStagedMigration,
      automationsBusy: input.automationsBusy,
      activationFenceExists
    },
    stop: async (evidence) => {
      await stopForIdle(input, evidence, retireKingudDaemonIfIdle)
      // Clients or providers may return while daemon retirement awaits its reply.
      const activity = input.rpc.readClientActivity()
      if (
        hasChatProviders() ||
        activity.openConnections > 0 ||
        activity.requestsInFlight > 0 ||
        activity.lastRequestAt > evidence.quietSince
      ) {
        discardKingudIdleStopRecord(input.userDataPath)
        return false
      }
      idleRecord.requestShutdown(requestIdleShutdown)
      return true
    }
  })
  input.registerCleanup(() => {
    dispose()
    idleRecord.onShutdown()
  })
}

/**
 * A stop that fails or overruns is not clean, and one another source (a signal, a stop request)
 * took over is not idle; the next start must report neither as an idle stop. `onShutdown` runs
 * in every stop's cleanup, so a takeover that finishes before the idle request is handled too.
 */
export function createIdleStopRecordOwnership(userDataPath: string): {
  requestShutdown(request: KingudShutdownTrigger | null): void
  onShutdown(): void
} {
  let idleOwnsStop = false
  const discard = (): void => discardKingudIdleStopRecord(userDataPath)
  return {
    requestShutdown: (request) => {
      // Set first: the stop this starts may run its cleanup before the trigger returns.
      idleOwnsStop = true
      if (request?.('idle', discard) !== true) {
        idleOwnsStop = false
        discard()
      }
    },
    onShutdown: () => {
      if (!idleOwnsStop) {
        discard()
      }
    }
  }
}

async function stopForIdle(
  input: { userDataPath: string; version: string },
  evidence: KingudIdleExitEvidence,
  retireDaemon: () => Promise<{ retirement: string; reason: string | null }>
): Promise<void> {
  console.error(`[kingud] stopping: no client, terminal or job for ${evidence.timeoutMs}ms`)
  try {
    writeKingudIdleStopRecord(input.userDataPath, evidence, input.version)
  } catch (error) {
    console.error('[kingud] could not record the idle stop:', error)
  }
  // The daemon leaves only if it proves itself empty; a busy one stays up with its terminals.
  const outcome = await retireDaemon().catch((error: unknown) => ({
    retirement: 'unverifiable',
    reason: String(error)
  }))
  console.error(
    `[kingud] terminal daemon on idle stop: ${outcome.retirement}${outcome.reason ? ` (${outcome.reason})` : ''}`
  )
}
