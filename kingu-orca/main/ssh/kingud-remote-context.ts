/** Everything a managed-kingud operation needs to know about one host (SSH or WSL) before it acts. */
import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import type { SshTarget } from '../../shared/ssh-types'
import type { KingudActivationRecord } from './kingud-activation-record'
import { readKingudActivationRecord } from './kingud-activation-record-store'
import { resolveKingudRuntimeTarget } from './kingud-runtime-target'
import { prepareWindowsKingudHost } from './kingud-windows-host-preparation'
import {
  isWslKingudHostTarget,
  type KingudHostTarget,
  type KingudHostTransport
} from './kingud-host-transport'
import {
  decideKingudMachineHome,
  kingudMachineClaimCommand,
  kingudMachineDataRoot,
  kingudMachineHomeDir,
  kingudMachineHomeProbeCommand,
  parseKingudMachineClaim,
  parseKingudMachineHomeProbe
} from './kingud-machine-home'
import { execKingudRemote, type KingudRemoteExecTarget } from './kingud-remote-runtime-control'
import { readRemoteHomeCommand } from './ssh-remote-commands'
import { shellEscape } from './ssh-connection-utils'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  normalizeRemoteHome,
  validateRemoteHome,
  type RemoteHostPlatform
} from './ssh-remote-platform'
import { detectRemoteHostPlatform } from './ssh-remote-platform-detection'
import { KingudHostUnsupportedError } from '../kingud/kingud-host-unavailable'
import { rememberSshHostPlatform } from './ssh-host-platform-memo'

/** Defaults to SSH: most lifecycle code still reads SSH-only target fields. */
export type KingudRemoteContext<Target extends KingudHostTarget = SshTarget> = {
  activationRecord: KingudActivationRecord
  /** A compat runtime on hosts below the default runtime's glibc floor (design D6 rung B). */
  serverTarget: NodeRuntimeTarget
  connection: KingudHostTransport
  host: RemoteHostPlatform
  /**
   * What `~/.kingu-remote` hangs off: the login home, or this machine's own home when several
   * machines share one (see `kingud-machine-home.ts`). `userDataDir` follows the same choice.
   */
  remoteHome: string
  target: Target
  userDataDir: string
}

export async function resolveKingudRemoteContext<Target extends KingudHostTarget = SshTarget>(
  target: Target,
  connection: KingudHostTransport,
  signal?: AbortSignal,
  detectedHost?: RemoteHostPlatform
): Promise<KingudRemoteContext<Target>> {
  const host = detectedHost ?? (await detectRemoteHostPlatform(connection, { signal }))
  if (!host) {
    throw new KingudHostUnsupportedError(
      'This SSH host platform is not supported by managed kingud.'
    )
  }
  const remote = { conn: connection, host, signal }
  const { kingudHome: remoteHome, userDataDir } = await resolveKingudMachineHome(
    remote,
    !isWslKingudHostTarget(target)
  )
  const serverTarget = await resolveKingudRuntimeTarget({
    conn: connection,
    host,
    signal
  })
  if (!isWslKingudHostTarget(target)) {
    rememberSshHostPlatform(target.id, host, serverTarget)
  }
  if (isWindowsRemoteHost(host)) {
    // Every Windows host op, the activation record read included, runs on the pinned node.exe.
    await prepareWindowsKingudHost({
      conn: connection,
      host,
      remoteHome,
      serverTarget,
      signal
    })
  }
  const activationRecord = await readKingudActivationRecord({
    ...remote,
    remoteHome
  })
  return {
    activationRecord,
    serverTarget,
    connection,
    host,
    remoteHome,
    target,
    userDataDir
  }
}

/**
 * The directory kingud's state hangs off on this machine: the login home, or this machine's own
 * home under it. Windows and WSL keep the login home: neither shares one across machines.
 */
export async function resolveKingudMachineHome(
  remote: KingudRemoteExecTarget,
  keyByMachine: boolean
): Promise<{ loginHome: string; kingudHome: string; userDataDir: string }> {
  const { host } = remote
  if (!keyByMachine || isWindowsRemoteHost(host)) {
    const loginHome = normalizeRemoteHome(
      await execKingudRemote(remote, readRemoteHomeCommand(host)),
      host
    )
    if (!validateRemoteHome(loginHome, host)) {
      throw new Error(`Remote home is not a valid path: ${loginHome.slice(0, 100)}`)
    }
    return {
      loginHome,
      kingudHome: loginHome,
      userDataDir: joinRemotePath(host, loginHome, '.kingu')
    }
  }
  const probe = parseKingudMachineHomeProbe(
    await execKingudRemote(remote, kingudMachineHomeProbeCommand(host)),
    host
  )
  const { loginHome } = probe
  let decision = decideKingudMachineHome(probe, host)
  if (decision.kind === 'claim') {
    const won = parseKingudMachineClaim(
      (
        await execKingudRemote(
          remote,
          kingudMachineClaimCommand(host, loginHome, decision.machineKey)
        )
      ).trim()
    )
    if (won.state !== 'present') {
      throw new Error(`kingud could not claim this host's ${RELAY_REMOTE_DIR}`)
    }
    decision =
      won.machineKey === decision.machineKey
        ? { kind: 'login-home' }
        : { kind: 'machine-home', machineKey: decision.machineKey }
  }
  if (decision.kind === 'login-home') {
    return {
      loginHome,
      kingudHome: loginHome,
      userDataDir: joinRemotePath(host, loginHome, '.kingu')
    }
  }
  const kingudHome = kingudMachineHomeDir(host, loginHome, decision.machineKey)
  await execKingudRemote(remote, `umask 077; mkdir -p ${shellEscape(kingudHome)}`)
  return {
    loginHome,
    kingudHome,
    userDataDir: kingudMachineDataRoot(host, loginHome, decision.machineKey)
  }
}
