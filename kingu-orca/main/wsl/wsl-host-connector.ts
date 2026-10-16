/** The production WSL side of `WslHostService`: one holder, connection manager and supervisor. */
import { isWslDistroRunning } from '../wsl-background-distro-gate'
import { createWslDistroHolder, type WslDistroHolder } from './wsl-distro-holder'
import { listWslHostDistros } from './wsl-host-distro-list'
import type { WslHostConnector } from './wsl-host-service'
import { readWslDistroKingudPublicKey } from './wsl-host-ssh-kingud-conflict'
import {
  WslKingudConnectionManager,
  type WslKingudConnectionDependencies
} from './wsl-kingud-connection'
import { defaultWslKingudEnvironmentId, deployAndLaunchWslKingud } from './wsl-kingud-deploy'
import { createWslKingudHostTransport } from './wsl-kingud-host-transport'
import type { WslKingudHostTarget } from './wsl-kingud-host-target'
import {
  decommissionWslHostKingud,
  stopWslHostServer,
  wslHostRuntimeStopSteps,
  type WslHostRuntimeAccess
} from './wsl-host-server-stop'
import { createWslKingudLivenessSupervisor } from './wsl-kingud-liveness-wiring'
import type { WslKingudLivenessSupervisor } from './wsl-kingud-liveness-supervisor'

function targetFor(distro: string): WslKingudHostTarget {
  return { kind: 'wsl', id: defaultWslKingudEnvironmentId(distro), distro, label: distro }
}

function transportFor(distro: string) {
  return createWslKingudHostTransport({ target: targetFor(distro) })
}

export function createWslHostConnector(options: {
  userDataPath: string
  onChange: NonNullable<WslKingudConnectionDependencies['onChange']>
  hasUserVisibleWork: (distro: string) => boolean
  /** False once a distro's host is gone: nothing may be spawned for it again. */
  isKnownDistro: (distro: string) => boolean
  runtime: WslHostRuntimeAccess
}): WslHostConnector {
  const refuseUnknown = (distro: string): Error =>
    new Error(`${distro} is no longer a WSL host; Kingu will not start anything for it.`)
  // Assigned below; a holder exit cannot arrive before the first ensure.
  let supervisor: WslKingudLivenessSupervisor | null = null
  const unguardedHolder = createWslDistroHolder({
    userDataPath: options.userDataPath,
    onHolderExit: (distro, exit) => supervisor?.noteHolderExit(distro, exit)
  })
  // Why guard here: liveness recovery and deploy both reach these without the service.
  const holder: WslDistroHolder = {
    ...unguardedHolder,
    ensureHeld: (distro) =>
      options.isKnownDistro(distro)
        ? unguardedHolder.ensureHeld(distro)
        : Promise.reject(refuseUnknown(distro))
  }
  const manager = new WslKingudConnectionManager({
    holder,
    onChange: options.onChange,
    deployAndLaunch: (distro, deployOptions) =>
      options.isKnownDistro(distro)
        ? deployAndLaunchWslKingud(distro, deployOptions)
        : Promise.reject(refuseUnknown(distro))
  })
  const liveness = createWslKingudLivenessSupervisor({
    manager,
    holder,
    hasUserVisibleWork: options.hasUserVisibleWork
  })
  supervisor = liveness
  return {
    listDistros: () => listWslHostDistros(),
    readKingudPublicKey: (distro) => readWslDistroKingudPublicKey(transportFor(distro)),
    connect: (distro, connectOptions) => liveness.connect(distro, connectOptions),
    get: (distro) => manager.get(distro),
    disconnect: (distro) => liveness.stop(distro),
    stopServer: async (distro, environmentId) => {
      if (!manager.get(distro)) {
        // A stopped distro runs nothing; a running one is reached without booting it.
        if (!(await isWslDistroRunning(distro))) {
          return { stopped: true }
        }
        await liveness.connect(distro)
      }
      const target = targetFor(distro)
      return stopWslHostServer({
        ...wslHostRuntimeStopSteps(options.runtime, environmentId),
        closeBridge: () => liveness.stop(distro),
        decommission: decommissionWslHostKingud(target, createWslKingudHostTransport({ target }))
      })
    },
    releaseHolder: async (distro) => {
      await holder.release(distro)
    },
    adoptHolders: async () => {
      await holder.adoptHolders()
    },
    dispose: () => liveness.dispose()
  }
}
