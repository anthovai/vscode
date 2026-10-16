/**
 * Asks a managed kingud, through its tunnel, how many terminals its daemon runs. Every failure,
 * including an older host without the method, reads as an unverifiable census, never as zero.
 */
import { KINGUD_TERMINAL_CENSUS_RUNTIME_CAPABILITY } from '../../shared/kingud-runtime-capabilities'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import {
  KINGUD_TERMINAL_CENSUS_METHOD,
  KingudTerminalCensusSchema,
  type KingudTerminalCensus
} from '../../shared/kingud-terminal-census'
import { sendRemoteRuntimeRequestWithStatusPreflight } from '../../shared/remote-runtime-client'
import type { KingudActivationRecord } from './kingud-activation-record'
import { ensureKingudManagedTunnel } from './kingud-managed-tunnel'
import { verifyKingudManagedServing } from './kingud-managed-serving-verify'

const UNVERIFIABLE: KingudTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
}

/**
 * The census through the server's ensured tunnel, after starting a server that idled out; a
 * tunnel that cannot open, or a server that cannot start, is unverifiable.
 */
export async function collectManagedTerminalCensus(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  record: KingudActivationRecord,
  timeoutMs = 15_000,
  options: { releaseFinishedAutomationTerminals?: boolean } = {}
): Promise<KingudTerminalCensus> {
  if (!record.active) {
    return { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
  }
  const activatedAt = record.activatedAt ? Date.parse(record.activatedAt) : Number.NaN
  if (!Number.isFinite(activatedAt) || activatedAt < 0) {
    return UNVERIFIABLE
  }
  try {
    await ensureKingudManagedTunnel(userDataPath, environment.id)
    // A server that idled out behind a forward still up is started first, or it never answers.
    await verifyKingudManagedServing(userDataPath, environment.id)
    return await requestKingudTerminalCensus(
      getPreferredPairedRuntimeConnection(environment),
      activatedAt,
      timeoutMs,
      options
    )
  } catch {
    return UNVERIFIABLE
  }
}

/** The census over an already-open connection; any failure is unverifiable, never zero. */
export async function requestKingudTerminalCensus(
  connection: PairedRuntimeConnection,
  activatedAt: number,
  timeoutMs = 15_000,
  options: { releaseFinishedAutomationTerminals?: boolean } = {}
): Promise<KingudTerminalCensus> {
  try {
    const response = await sendRemoteRuntimeRequestWithStatusPreflight<unknown>(
      connection,
      KINGUD_TERMINAL_CENSUS_METHOD,
      {
        activatedAt,
        ...(options.releaseFinishedAutomationTerminals
          ? { releaseFinishedAutomationTerminals: true }
          : {})
      },
      timeoutMs,
      (status) => {
        if (
          !status.ok ||
          !status.result.capabilities?.includes(KINGUD_TERMINAL_CENSUS_RUNTIME_CAPABILITY)
        ) {
          throw new Error('The managed Kingu server does not report a terminal census.')
        }
      },
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    return response.ok ? KingudTerminalCensusSchema.parse(response.result) : UNVERIFIABLE
  } catch {
    return UNVERIFIABLE
  }
}
