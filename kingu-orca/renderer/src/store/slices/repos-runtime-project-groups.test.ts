import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('repo slice runtime project groups', () => {
  it('keeps runtime copies of a grouped canonical project in the same project group', async () => {
    const gitRemoteIdentity = {
      canonicalKey: 'github.com/anthovai/kingu-intelligence',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/anthovai/kingu-intelligence.git'
    }
    const localKingu: Repo = {
      id: 'local-kingu',
      path: '/Users/alice/stably/kingu',
      displayName: 'kingu',
      badgeColor: '#000',
      addedAt: 1,
      executionHostId: 'local',
      gitRemoteIdentity,
      projectGroupId: 'group-kingu'
    }
    const runtimeKingu: Repo = {
      id: 'runtime-kingu',
      path: '/vercel/sandbox/kingu',
      displayName: 'kingu',
      badgeColor: '#111',
      addedAt: 2,
      gitRemoteIdentity
    }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-runtime-kingu',
      ok: true,
      result: { repos: [runtimeKingu] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [localKingu]
    })

    await store.getState().fetchRepos()

    expect(store.getState().repos).toEqual([
      localKingu,
      {
        ...runtimeKingu,
        executionHostId: 'runtime:env-1',
        projectGroupId: 'group-kingu'
      }
    ])
  })
})
