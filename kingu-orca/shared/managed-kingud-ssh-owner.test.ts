import { describe, expect, it } from 'vitest'
import {
  getLegacyManagedKingudOwnerEnvironmentId,
  getManagedKingudFenceEnvironmentId,
  isEphemeralRuntimeSshOwner,
  managedKingudServerName
} from './managed-kingud-ssh-owner'

describe('managed kingud SSH fence', () => {
  it('reads the fence from kingudFence, never from owner', () => {
    expect(getManagedKingudFenceEnvironmentId({ kingudFence: { environmentId: 'env-1' } })).toBe(
      'env-1'
    )
    expect(getManagedKingudFenceEnvironmentId({})).toBeNull()
    expect(getManagedKingudFenceEnvironmentId(undefined)).toBeNull()
  })

  it('recognises the legacy owner fence only so loading can migrate it', () => {
    const legacy = { type: 'on-demand-runtime' as const, runtimeId: 'managed-kingud:env-1' }
    expect(getLegacyManagedKingudOwnerEnvironmentId(legacy)).toBe('env-1')
    expect(isEphemeralRuntimeSshOwner(legacy)).toBe(false)
  })

  it('keeps ordinary on-demand runtime targets ephemeral', () => {
    const owner = { type: 'on-demand-runtime' as const, runtimeId: 'runtime-1' }
    expect(getLegacyManagedKingudOwnerEnvironmentId(owner)).toBeNull()
    expect(isEphemeralRuntimeSshOwner(owner)).toBe(true)
  })

  it("names a recipe VM's server after its runtime, so two VMs of one recipe never collide", () => {
    const owner = { type: 'on-demand-runtime' as const, runtimeId: 'runtime-0123456789abcdef' }
    expect(managedKingudServerName({ label: 'Docker root', owner })).toBe('Docker root VM 89abcdef')
    expect(managedKingudServerName({ label: 'Builder' })).toBe('Builder')
  })
})
