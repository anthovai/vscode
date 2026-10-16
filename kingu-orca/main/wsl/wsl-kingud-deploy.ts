/**
 * Deploys and starts kingud inside one WSL distro (design D1, D2b, D8), reusing the SSH host's
 * install, activation fence/journal and version admission over the `wsl.exe` transport.
 * No pairing here: the stdio bridge (C5) connects to the loopback port this reports.
 */
import { getAppEnvironment } from '../../shared/app-environment'
import { KINGUD_MANAGED_REMOTE_PORT } from '../../shared/kingud-managed-runtime'
import type { ServeReadiness } from '../server/serve-readiness'
import type { WslHostDeferredUpdate } from '../../shared/wsl-host-types'
import { recoverInterruptedKingudActivation } from '../ssh/kingud-activation-recovery'
import { readKingudActivationRecord } from '../ssh/kingud-activation-record-store'
import { materializeKingudArtifact } from '../kingud/kingud-artifact-materializer'
import { KingudHostUnsupportedError } from '../kingud/kingud-host-unavailable'
import type { KingudHostTransport } from '../ssh/kingud-host-transport'
import { KINGUD_ACTIVATION_POLICY_REFUSED_CODE } from '../ssh/kingud-installed-activation'
import { kingudBoundPort } from '../ssh/kingud-managed-bound-port'
import {
  isForceableKingudDeferral,
  managedKingudDeployPolicy,
  managedKingudInstallDir,
  managedKingudSlot,
  probeManagedKingudReadiness
} from '../ssh/kingud-managed-runtime-context'
import { isWaitingKingudUpdateDeferral } from '../ssh/kingud-managed-auto-update'
import { pruneManagedKingudVersions } from '../ssh/kingud-managed-version-gc'
import { wakeAlreadyActiveKingud } from '../ssh/kingud-already-active-wake'
import { resolveKingudRemoteContext } from '../ssh/kingud-remote-context'
import { deployKingud } from '../ssh/kingud-remote-deploy'
import { KINGUD_PID_FILENAME } from '../ssh/kingud-remote-launch'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { execCommand } from '../ssh/ssh-relay-exec-command'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { readLocalFullVersion } from '../ssh/remote-versioned-install'
import { createWslDistroHolder, type WslDistroHolder } from './wsl-distro-holder'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import { readWslDistroRegistryIdShared } from './wsl-distro-registry-id'
import type { WslKingudHostTarget } from './wsl-kingud-host-target'
import {
  createWslKingudHostTransport,
  type WslKingudHostTransport
} from './wsl-kingud-host-transport'
import { readWslKingudIncumbent, type WslKingudIncumbent } from './wsl-kingud-incumbent'
import { adoptUnrecordedWslKingud } from './wsl-kingud-instance-adoption'

/** An update this app carries that the host may not take yet; the incumbent keeps serving. */
export type WslKingudDeferredUpdate = WslHostDeferredUpdate

export type WslKingudLaunch =
  | {
      outcome: 'ready'
      distro: string
      /** The Lxss registration GUID for the deployment record's `distroId`; null if unreadable. */
      distroId: string | null
      /** The loopback port kingud bound inside the distro (another one when the preferred was taken). */
      port: number
      fullVersion: string
      pid: number | null
      readiness: ServeReadiness
      holder: 'adopted' | 'spawned' | 'unverifiable'
      /** An kingud the record did not name (e.g. left by a failed Remove), now recorded. */
      adoptedInstance?: { version: string; pid: number }
      /** Set when `fullVersion` is the incumbent because the update must wait. */
      deferredUpdate?: WslKingudDeferredUpdate
    }
  | ({ outcome: 'deferred'; distro: string } & WslKingudDeferredUpdate)

export type WslKingudDeployOptions = {
  /** The WSL environment's id; keys host-scoped state (wake dedupe). Defaults per distro. */
  environmentId?: string
  label?: string
  force?: boolean
  signal?: AbortSignal
  /** Defaults to one created over `userData`; the app should pass its shared instance. */
  holder?: WslDistroHolder
  createTransport?: (target: WslKingudHostTarget) => KingudHostTransport & { dispose?(): void }
  readRegistryId?: (distro: string) => Promise<string | null>
  readIncumbent?: typeof readWslKingudIncumbent
  /** The kingud template to deploy from; defaults to the packaged one (the C10 lane swaps it). */
  templateDir?: string
}

/** Until the persisted deployment record (C7) assigns one, the environment is keyed per distro. */
export function defaultWslKingudEnvironmentId(distro: string): string {
  return `wsl:${wslDistroHolderKey(distro)}`
}

/** WSL 1 runs no Linux kernel, so the pinned Node and its pty cannot run there. */
export function isWsl1KernelRelease(release: string): boolean {
  return /^\d+\.\d+\.\d+-\d+-Microsoft$/.test(release.trim())
}

export async function deployAndLaunchWslKingud(
  distro: string,
  options: WslKingudDeployOptions = {}
): Promise<WslKingudLaunch> {
  const name = distro.trim()
  if (!name) {
    throw new Error('A WSL distro name is required')
  }
  const target: WslKingudHostTarget = {
    kind: 'wsl',
    id: options.environmentId ?? defaultWslKingudEnvironmentId(name),
    distro: name,
    label: options.label ?? name
  }
  const conn = (options.createTransport ?? defaultTransport)(target)
  try {
    return await launchOverTransport(name, target, conn, options)
  } finally {
    conn.dispose?.()
  }
}

async function launchOverTransport(
  name: string,
  target: WslKingudHostTarget,
  conn: KingudHostTransport,
  options: WslKingudDeployOptions
): Promise<WslKingudLaunch> {
  const { signal } = options
  const kernel = await execCommand(conn, 'uname -r', { signal })
  if (isWsl1KernelRelease(kernel)) {
    throw new KingudHostUnsupportedError(
      `The WSL 1 distro ${name} is not supported by managed kingud. ` +
        `Convert it with: wsl --set-version ${name} 2`
    )
  }
  // Before the launch: without a holder WSL stops an idle distro and kingud with it.
  const holder = options.holder ?? createWslDistroHolder({ userDataPath: userDataPath() })
  const held = await holder.ensureHeld(name)
  // Read alongside the deploy; a failed read only leaves the record without a GUID.
  const distroId = (options.readRegistryId ?? readWslDistroRegistryIdShared)(name).catch(() => null)
  let context = await resolveKingudRemoteContext(target, conn, signal)
  const slot = managedKingudSlot(context, KINGUD_MANAGED_REMOTE_PORT, signal)
  const recovery = await recoverInterruptedKingudActivation(slot)
  if (recovery.outcome === 'pending' || recovery.outcome === 'refused') {
    throw new Error(recovery.reason)
  }
  if (recovery.outcome === 'recovered') {
    context = { ...context, activationRecord: await readKingudActivationRecord(slot) }
  }
  // Before deploy or wake: an kingud the record does not name would keep the instance lock.
  const adoption = await adoptUnrecordedWslKingud(slot, context.activationRecord)
  if (adoption.outcome === 'adopted') {
    context = { ...context, activationRecord: adoption.record }
  }
  const localKingudDir = await materializeKingudArtifact(context.serverTarget, {
    signal,
    trustVerificationRecord: true,
    ...(options.templateDir ? { templateDir: options.templateDir } : {})
  })
  const appVersion = getAppEnvironment().getVersion()
  const incumbentVersion = context.activationRecord.active
  // Only an update asks the incumbent: the same version is a no-op deploy on every connect.
  const incumbent: WslKingudIncumbent | null =
    incumbentVersion && incumbentVersion !== readLocalFullVersion(localKingudDir)
      ? await (options.readIncumbent ?? readWslKingudIncumbent)({
          context,
          slot
        })
      : null
  const deployed = await deployKingud({
    ...slot,
    conn,
    localKingudDir,
    target: context.serverTarget,
    ...managedKingudDeployPolicy(context, appVersion, options.force),
    ...(incumbent ? { census: incumbent.census } : {}),
    ...(incumbent?.recount ? { recountCensus: incumbent.recount } : {}),
    force: options.force,
    appVersion,
    recordedNodeRuntimeProbe: true
  })
  if (deployed.outcome === 'installed-not-activated') {
    const deferredUpdate: WslKingudDeferredUpdate = {
      candidateVersion: deployed.fullVersion,
      code: deployed.code,
      reason: deployed.reason,
      forceable:
        isForceableKingudDeferral(deployed.code) ||
        deployed.code === KINGUD_ACTIVATION_POLICY_REFUSED_CODE
    }
    // Waiting (e.g. live terminals) is not broken: the incumbent serves until Update or Force.
    if (
      incumbentVersion &&
      incumbent?.readiness &&
      isWaitingKingudUpdateDeferral(deployed.code) &&
      // Another client may have activated a build since the census; then this one is stale.
      (await readKingudActivationRecord(slot)).active === incumbentVersion
    ) {
      const serving = {
        fullVersion: incumbentVersion,
        readiness: incumbent.readiness
      }
      return { ...(await readyLaunch(serving)), deferredUpdate }
    }
    return { outcome: 'deferred', distro: name, ...deferredUpdate }
  }
  if (deployed.outcome === 'already-active') {
    // A stopped distro ended the active slot with it.
    await wakeAlreadyActiveKingud(slot)
  }
  const readiness = await probeManagedKingudReadiness(
    context,
    localKingudDir,
    deployed.fullVersion,
    signal
  )
  await pruneManagedKingudVersions({
    slot,
    serverTarget: context.serverTarget,
    activeVersion: deployed.fullVersion,
    readiness
  })
  return readyLaunch({ fullVersion: deployed.fullVersion, readiness })

  async function readyLaunch(serving: {
    fullVersion: string
    readiness: ServeReadiness
  }): Promise<Extract<WslKingudLaunch, { outcome: 'ready' }>> {
    const pidFile = joinRemotePath(
      context.host,
      managedKingudInstallDir(context, serving.fullVersion),
      KINGUD_PID_FILENAME
    )
    const pid = Number.parseInt(
      await execCommand(conn, `cat ${shellEscape(pidFile)} 2>/dev/null || true`, { signal }),
      10
    )
    return {
      outcome: 'ready',
      distro: name,
      distroId: await distroId,
      port: kingudBoundPort(serving.readiness) ?? KINGUD_MANAGED_REMOTE_PORT,
      fullVersion: serving.fullVersion,
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      readiness: serving.readiness,
      holder: held.outcome,
      ...(adoption.outcome === 'adopted'
        ? { adoptedInstance: { version: adoption.version, pid: adoption.pid } }
        : {})
    }
  }
}

function defaultTransport(target: WslKingudHostTarget): WslKingudHostTransport {
  return createWslKingudHostTransport({ target })
}

function userDataPath(): string {
  return getAppEnvironment().getPath('userData')
}
