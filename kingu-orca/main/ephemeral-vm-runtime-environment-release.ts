import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { removeManagedKingudEnvironment } from '../shared/runtime-environment-managed-kingud-store'
import { listEnvironments, removeEnvironment } from '../shared/runtime-environment-store'
import { getKingudSshDeployment } from '../shared/runtime-environments'

/** Forgets the servers a destroyed VM ran; a managed one's tunnel would otherwise keep redialing. */
export async function releaseEphemeralVmRuntimeEnvironments(
  userDataPath: string,
  runtime: Pick<EphemeralVmRuntimeRecord, 'runtimeEnvironmentId' | 'sshTargetId'>
): Promise<void> {
  // Why the target too: a relay-era VM converted on connect never recorded its server's id.
  const environments = listEnvironments(userDataPath).filter(
    (entry) =>
      entry.id === runtime.runtimeEnvironmentId ||
      (runtime.sshTargetId !== undefined &&
        getKingudSshDeployment(entry)?.sshTargetId === runtime.sshTargetId)
  )
  for (const environment of environments) {
    if (!environment.kingudDeployment) {
      removeEnvironment(userDataPath, environment.id)
      continue
    }
    const { closeKingudManagedTunnel } = await import('./ssh/kingud-managed-tunnel')
    await closeKingudManagedTunnel(environment.id).catch(() => undefined)
    removeManagedKingudEnvironment(userDataPath, environment.id)
  }
}
