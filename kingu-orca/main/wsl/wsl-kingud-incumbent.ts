/**
 * The kingud a WSL host already runs, read before an app update replaces it (Track E1). SSH asks
 * it through its tunnel; a WSL host has no standing tunnel during deploy, so this opens a
 * short-lived stdio bridge. Anything unproven reads as an unverifiable census, never zero.
 */
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { parsePairingCode } from '../../shared/pairing'
import { KINGUD_MANAGED_REMOTE_PORT } from '../../shared/kingud-managed-runtime'
import type { KingudTerminalCensus } from '../../shared/kingud-terminal-census'
import type { ServeReadiness } from '../server/serve-readiness'
import { probeActiveKingudReadiness } from '../ssh/kingud-active-readiness'
import { kingudBoundPort } from '../ssh/kingud-managed-bound-port'
import { managedKingudInstallDir } from '../ssh/kingud-managed-runtime-context'
import { wakeStoppedManagedKingud } from '../ssh/kingud-managed-wake'
import type { KingudRemoteContext } from '../ssh/kingud-remote-context'
import type { KingudSlotOptions } from '../ssh/kingud-recovery-slot'
import { readRemoteKingudBuildHash } from '../ssh/kingud-remote-build-hash'
import { requestKingudTerminalCensus } from '../ssh/kingud-terminal-census-client'
import { tunneledKingudPairingCode } from '../ssh/kingud-tunneled-pairing'
import type { StartedPortForward } from '../ssh/ssh-port-forward-provider'
import type { KingudHostTransport } from '../ssh/kingud-host-transport'
import type { WslKingudHostTarget } from './wsl-kingud-host-target'
import { listenWslKingudStdioBridge } from './wsl-kingud-stdio-bridge'

export type WslKingudIncumbent = {
  census: KingudTerminalCensus
  /** The incumbent's proven readiness; null when it could not be started or proven. */
  readiness: ServeReadiness | null
  /** Counts again (no wake) just before activation stops the incumbent; null without readiness. */
  recount: (() => Promise<KingudTerminalCensus>) | null
}

const UNVERIFIABLE: KingudTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
}

export type WslKingudIncumbentDependencies = {
  wake: typeof wakeStoppedManagedKingud
  probe: typeof probeActiveKingudReadiness
  readBuildHash: typeof readRemoteKingudBuildHash
  listen: (
    transport: KingudHostTransport,
    remotePort: number,
    target: WslKingudHostTarget
  ) => Promise<StartedPortForward>
  census: typeof requestKingudTerminalCensus
}

const DEFAULT_DEPENDENCIES: WslKingudIncumbentDependencies = {
  wake: wakeStoppedManagedKingud,
  probe: probeActiveKingudReadiness,
  readBuildHash: readRemoteKingudBuildHash,
  listen: (transport, remotePort, target) =>
    listenWslKingudStdioBridge(transport, {
      environmentId: target.id,
      remotePort,
      localPort: 0,
      label: `Kingu server in WSL: ${target.label} (update check)`
    }),
  census: requestKingudTerminalCensus
}

/**
 * Wakes the active slot if a reboot or idle exit stopped it (its daemon then starts empty, so
 * the census proves zero), then asks it for its census over a bridge closed before returning.
 */
export async function readWslKingudIncumbent(
  args: {
    context: KingudRemoteContext<WslKingudHostTarget>
    slot: KingudSlotOptions
  },
  dependencies: WslKingudIncumbentDependencies = DEFAULT_DEPENDENCIES
): Promise<WslKingudIncumbent> {
  const record = args.context.activationRecord
  const activatedAt = record.activatedAt ? Date.parse(record.activatedAt) : Number.NaN
  if (!record.active || !Number.isFinite(activatedAt) || activatedAt < 0) {
    return { census: UNVERIFIABLE, readiness: null, recount: null }
  }
  let readiness: ServeReadiness
  try {
    const wake = await dependencies.wake(args.slot)
    if (wake.outcome === 'started') {
      readiness = wake.readiness
    } else if (wake.outcome === 'serving') {
      const remoteInstallDir = managedKingudInstallDir(args.context, record.active)
      readiness = await dependencies.probe(
        { ...args.slot, remoteInstallDir },
        {
          buildHash: await dependencies.readBuildHash(args.slot, remoteInstallDir),
          fullVersion: record.active
        }
      )
    } else {
      return { census: UNVERIFIABLE, readiness: null, recount: null }
    }
  } catch {
    return { census: UNVERIFIABLE, readiness: null, recount: null }
  }
  const recount = (): Promise<KingudTerminalCensus> =>
    countIncumbentTerminals(args, readiness, activatedAt, dependencies)
  return { census: await recount(), readiness, recount }
}

async function countIncumbentTerminals(
  args: { context: KingudRemoteContext<WslKingudHostTarget>; slot: KingudSlotOptions },
  readiness: ServeReadiness,
  activatedAt: number,
  dependencies: WslKingudIncumbentDependencies
): Promise<KingudTerminalCensus> {
  let forward: StartedPortForward | null = null
  try {
    forward = await dependencies.listen(
      args.slot.conn,
      kingudBoundPort(readiness) ?? KINGUD_MANAGED_REMOTE_PORT,
      args.context.target
    )
    const offer = parsePairingCode(tunneledKingudPairingCode(readiness, forward.entry.localPort))
    if (!offer) {
      return UNVERIFIABLE
    }
    // Why release: finished automation shells would otherwise defer every update, as on SSH.
    return await dependencies.census(
      pairedRuntimeConnectionFromOffer(offer),
      activatedAt,
      undefined,
      { releaseFinishedAutomationTerminals: true }
    )
  } catch {
    return UNVERIFIABLE
  } finally {
    await forward?.close().catch(() => {})
  }
}
