import type { SshTarget } from './ssh-types'

/** The runtime id phase-3 builds wrote into `owner` before the fence moved to `kingudFence`. */
const LEGACY_MANAGED_KINGUD_RUNTIME_ID_PREFIX = 'managed-kingud:'

type SshTargetOwner = NonNullable<SshTarget['owner']>

/** The managed Kingu server this host serves, or null for a direct SSH host. */
export function getManagedKingudFenceEnvironmentId(
  target: Pick<SshTarget, 'kingudFence'> | undefined
): string | null {
  return target?.kingudFence?.environmentId || null
}

/** Reads a legacy `owner` fence, only to migrate it to `kingudFence` on load. */
export function getLegacyManagedKingudOwnerEnvironmentId(
  owner: SshTargetOwner | undefined
): string | null {
  if (!owner?.runtimeId.startsWith(LEGACY_MANAGED_KINGUD_RUNTIME_ID_PREFIX)) {
    return null
  }
  return owner.runtimeId.slice(LEGACY_MANAGED_KINGUD_RUNTIME_ID_PREFIX.length) || null
}

export function isEphemeralRuntimeSshOwner(owner: SshTargetOwner | undefined): boolean {
  return (
    owner?.type === 'on-demand-runtime' && getLegacyManagedKingudOwnerEnvironmentId(owner) === null
  )
}

/** Every VM a recipe makes shares its label, so the runtime id keeps their server names unique. */
export function managedKingudServerName(target: Pick<SshTarget, 'label' | 'owner'>): string {
  const runtimeId = isEphemeralRuntimeSshOwner(target.owner) ? target.owner?.runtimeId : undefined
  return runtimeId ? `${target.label} VM ${runtimeId.slice(-8)}` : target.label
}
