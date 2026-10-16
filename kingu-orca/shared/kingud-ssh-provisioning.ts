import type { KingudManagedDeployResult } from './kingud-managed-runtime'
import type { SshRepoReadoption, SshTargetCreateInput } from './ssh-types'

export type KingudSshProvisioningIntent = Readonly<{
  requestId: string
  name: string
}>

export type KingudSshProvisioningRequest = KingudSshProvisioningIntent & {
  target: SshTargetCreateInput
}

export type KingudSshPendingProvisioning = KingudSshProvisioningIntent & {
  sshTargetId: string
}

export type KingudSshProvisioningResult = KingudSshPendingProvisioning & {
  repoReadoptions: SshRepoReadoption[]
  result: KingudManagedDeployResult | { outcome: 'pending'; reason: string }
}
