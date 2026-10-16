import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, parsePairingCode, type PairingOffer } from '../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  markEnvironmentUsed
} from '../../shared/runtime-environment-store'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { KinguRuntimeService } from '../runtime/kingu-runtime'
import { KinguRuntimeRpcServer } from '../runtime/runtime-rpc'
import { verifyRuntimePairingIdentity } from '../runtime/runtime-environment-identity-verification'
import { verifyManagedKingudTunnelIdentity } from './kingud-managed-tunnel-identity'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const servers: KinguRuntimeRpcServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

/** An kingud process on `userDataPath`, the host profile that holds its E2EE key and devices. */
async function startKingud(userDataPath: string): Promise<KinguRuntimeRpcServer> {
  const server = new KinguRuntimeRpcServer({
    runtime: new KinguRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  servers.push(server)
  return server
}

function pairingOffer(server: KinguRuntimeRpcServer): PairingOffer {
  const offer = server.createPairingOffer({ address: '127.0.0.1', name: 'Desktop A' })
  if (!offer.available) {
    throw new Error('pairing unavailable')
  }
  return parsePairingCode(offer.pairingUrl)!
}

function managedEnvironment(pairing: PairingOffer, runtimeId: string): KnownRuntimeEnvironment {
  return {
    id: 'env-1',
    name: 'Box server',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId,
    preferredEndpointId: 'ws',
    endpoints: [
      {
        id: 'ws',
        kind: 'websocket',
        label: 'Box',
        endpoint: pairing.endpoint,
        deviceToken: pairing.deviceToken,
        publicKeyB64: pairing.publicKeyB64
      }
    ],
    connectionDependency: 'ssh-tunnel',
    kingudDeployment: {
      sshTargetId: 'box',
      sshTargetGeneration: 1,
      localPort: 46_768,
      remotePort: 6_768
    }
  }
}

/** The restarted process listens on a new port; the tunnel's local endpoint reaches it. */
function reachedThrough(pairing: PairingOffer, server: KinguRuntimeRpcServer): PairingOffer {
  const port = new URL(pairingOffer(server).endpoint).port
  const endpoint = new URL(pairing.endpoint)
  endpoint.port = port
  return { ...pairing, endpoint: endpoint.toString() }
}

describe('reopening a managed tunnel after kingud restarted elsewhere', () => {
  it('accepts the same host under a new runtime id, and its status recovers', async () => {
    const hostProfile = mkdtempSync(join(tmpdir(), 'kingud-host-'))
    const first = await startKingud(hostProfile)
    const paired = pairingOffer(first)
    const recorded = (
      await verifyRuntimePairingIdentity(pairedRuntimeConnectionFromOffer(paired), {
        runtimeId: null
      })
    ).verifiedRuntimeId
    await first.stop()

    // Another desktop updated or woke the host while this one was away.
    const restarted = await startKingud(hostProfile)
    const pairing = reachedThrough(paired, restarted)

    await expect(
      verifyManagedKingudTunnelIdentity(managedEnvironment(pairing, recorded))
    ).resolves.toEqual({ verdict: 'verified' })
    // The first authenticated status reply over the reopened tunnel records the new id.
    const status = await verifyRuntimePairingIdentity(pairedRuntimeConnectionFromOffer(pairing), {
      runtimeId: null
    })
    expect(status.verifiedRuntimeId).not.toBe(recorded)
    const desktopProfile = mkdtempSync(join(tmpdir(), 'desktop-a-'))
    const saved = addEnvironmentFromPairingCode(desktopProfile, {
      name: 'Box server',
      pairingCode: encodePairingOffer(pairing)
    })
    markEnvironmentUsed(desktopProfile, saved.id, { runtimeId: recorded })
    markEnvironmentUsed(desktopProfile, saved.id, {
      runtimeId: status.verifiedRuntimeId,
      pairingDeviceToken: pairing.deviceToken
    })
    expect(listEnvironments(desktopProfile)[0]?.runtimeId).toBe(status.verifiedRuntimeId)
  })

  it('still refuses a different host that answers on the tunnel', async () => {
    const paired = pairingOffer(await startKingud(mkdtempSync(join(tmpdir(), 'kingud-host-'))))
    const other = await startKingud(mkdtempSync(join(tmpdir(), 'kingud-other-')))

    await expect(
      verifyManagedKingudTunnelIdentity(
        managedEnvironment(reachedThrough(paired, other), 'runtime-recorded')
      )
    ).resolves.toMatchObject({ verdict: 'foreign' })
  })
})
