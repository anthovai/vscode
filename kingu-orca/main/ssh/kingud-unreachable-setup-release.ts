/**
 * Recovers a host an earlier build stranded: a conversion fenced it and registered its managed
 * server, but the host's sshd refuses the forward that server is reached by, so nothing was ever
 * staged there. The source still holds every row, so the server is unregistered and the fence
 * released through the undeployed-fence path, and the relay serves the host again. An kingud the
 * setup did activate is stopped first, so a later conversion starts fresh rather than deferring.
 */
import { listEnvironments } from '../../shared/runtime-environment-store'
import { removeManagedKingudEnvironment } from '../../shared/runtime-environment-managed-kingud-store'
import { findKingudMigrationSourceCutoverForTarget } from './kingud-migration-cutover-journal'
import { releaseUndeployedMigrationFence } from './kingud-migration-source-fence'
import { closeKingudManagedTunnel } from './kingud-managed-tunnel'
import type { SshTargetKingudClaims } from './ssh-target-kingud-claims'
import { withKingudActivationLock } from './kingud-activation-lock'
import { withDeactivatedVersionCommitted } from './kingud-activation-record'
import {
  readKingudActivationRecord,
  writeKingudActivationRecord
} from './kingud-activation-record-store'
import { managedKingudSlot } from './kingud-managed-runtime-context'
import { resolveKingudRemoteContext } from './kingud-remote-context'
import { kingudStopFreedTheHost } from './kingud-remote-process-control'
import { kingudSlotDir, stopKingudSlot } from './kingud-recovery-slot'
import { sshKingudHostTransport } from './kingud-ssh-host-transport'
import { getSshConnectionManager, getSshTargetRegistryStore } from './ssh-target-registry'
import { errorMessage } from '../../shared/error-message'

export async function releaseUnreachableKingudSetup(args: {
  userDataPath: string
  claims: SshTargetKingudClaims
  targetId: string
  signal?: AbortSignal
}): Promise<void> {
  const cutover = findKingudMigrationSourceCutoverForTarget(args.userDataPath, args.targetId)
  // Why only this phase: a staged or committed destination holds state only it can account for.
  if (cutover?.phase !== 'source-fenced') {
    return
  }
  const environmentId = cutover.destinationEnvironmentId
  await closeKingudManagedTunnel(environmentId).catch(() => undefined)
  await stopStrandedKingud(args.targetId, args.signal).catch((error: unknown) => {
    console.warn(`[kingud] Could not stop the unreachable setup's server: ${errorMessage(error)}`)
  })
  const isRegistered = (id: string): boolean =>
    listEnvironments(args.userDataPath).some((entry) => entry.id === id)
  // Unregister first: a crash after it leaves an undeployed fence, which the same path releases.
  if (isRegistered(environmentId)) {
    removeManagedKingudEnvironment(args.userDataPath, environmentId)
  }
  await releaseUndeployedMigrationFence({
    userDataPath: args.userDataPath,
    claims: args.claims,
    targetId: args.targetId,
    isDestinationRegistered: isRegistered,
    signal: args.signal
  })
}

/** Clears `active` only once the slot is proven exited; its daemon and terminals outlive it. */
async function stopStrandedKingud(targetId: string, signal?: AbortSignal): Promise<void> {
  const target = getSshTargetRegistryStore()?.getTarget(targetId)
  const connectionManager = getSshConnectionManager()
  if (!target || !connectionManager) {
    return
  }
  const context = await resolveKingudRemoteContext(
    target,
    sshKingudHostTransport(await connectionManager.connect(target)),
    signal
  )
  if (!context.activationRecord.active) {
    return
  }
  // The port only matters for a launch, which this never does.
  const slot = managedKingudSlot(context, 0, signal)
  await withKingudActivationLock(
    slot,
    async () => {
      const record = await readKingudActivationRecord(slot)
      if (!record.active) {
        return
      }
      const stopped = await stopKingudSlot(slot, kingudSlotDir(slot, record.active), false)
      if (kingudStopFreedTheHost(stopped)) {
        await writeKingudActivationRecord(slot, withDeactivatedVersionCommitted(record))
      }
    },
    () => undefined
  )
}
