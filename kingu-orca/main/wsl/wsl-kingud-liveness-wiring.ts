/** The production probes behind `WslKingudLivenessSupervisor`; C7 supplies what is user-visible. */
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { parsePairingCode } from '../../shared/pairing'
import type { KingudTerminalCensus } from '../../shared/kingud-terminal-census'
import { requestKingudTerminalCensus } from '../ssh/kingud-terminal-census-client'
import { subscribeSystemPowerLifecycle } from '../system-power-lifecycle'
import {
  deferUntilWslDistroRunning,
  readConfirmedRunningWslDistros
} from '../wsl-background-distro-gate'
import type { WslDistroHolder } from './wsl-distro-holder'
import { readWslGuestIdentity } from './wsl-guest-process-identity'
import type { WslKingudConnection, WslKingudConnectionManager } from './wsl-kingud-connection'
import { defaultWslKingudEnvironmentId } from './wsl-kingud-deploy'
import { WslKingudLivenessSupervisor } from './wsl-kingud-liveness-supervisor'
import { createWslKingudHostTransport } from './wsl-kingud-host-transport'
import { openWslKingudWatch } from './wsl-kingud-watch'

const UNVERIFIABLE_CENSUS: KingudTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
}

function transportFor(distro: string, environmentId = defaultWslKingudEnvironmentId(distro)) {
  return createWslKingudHostTransport({
    target: { kind: 'wsl', id: environmentId, distro, label: distro }
  })
}

/** Every session counts (activation time 0): liveness asks how many survived, not how new. */
function collectWslKingudCensus(connection: WslKingudConnection): Promise<KingudTerminalCensus> {
  const offer = parsePairingCode(connection.pairingOffer)
  return offer
    ? requestKingudTerminalCensus(pairedRuntimeConnectionFromOffer(offer), 0)
    : Promise.resolve(UNVERIFIABLE_CENSUS)
}

export function createWslKingudLivenessSupervisor(options: {
  manager: WslKingudConnectionManager
  holder: WslDistroHolder
  hasUserVisibleWork: (distro: string) => boolean
}): WslKingudLivenessSupervisor {
  return new WslKingudLivenessSupervisor({
    manager: options.manager,
    readRunning: readConfirmedRunningWslDistros,
    readIdentity: (distro, kingudPid) => readWslGuestIdentity(transportFor(distro), kingudPid),
    openWatch: (connection) =>
      openWslKingudWatch(
        transportFor(connection.distro, connection.environmentId),
        connection.remotePort
      ),
    collectCensus: collectWslKingudCensus,
    hasUserVisibleWork: options.hasUserVisibleWork,
    deferUntilRunning: deferUntilWslDistroRunning,
    ensureHolder: (distro) => options.holder.ensureHeld(distro),
    subscribePower: subscribeSystemPowerLifecycle
  })
}
