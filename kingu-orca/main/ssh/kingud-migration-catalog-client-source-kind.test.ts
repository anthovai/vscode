import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KINGUD_MIGRATION_MANIFEST_VERSION,
  type KingudMigrationManifest
} from '../../shared/kingud-migration-manifest'
import { KINGUD_MIGRATION_SOURCE_KIND_UNKNOWN } from '../../shared/kingud-migration-source-kind'
import {
  KINGUD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
  KINGUD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
} from '../../shared/kingud-runtime-capabilities'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { computeKingudMigrationManifestSha256 } from '../kingud/kingud-migration-manifest-digest'

const sendRequest = vi.hoisted(() => vi.fn())
const status = vi.hoisted((): { capabilities: string[] } => ({ capabilities: [] }))
vi.mock('../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequestWithStatusPreflight: async (
    pairing: unknown,
    method: string,
    params: unknown,
    _timeoutMs: number,
    validate: (response: unknown) => void
  ) => {
    validate({
      ok: true,
      _meta: { runtimeId: 'runtime' },
      result: { capabilities: status.capabilities }
    })
    return sendRequest(pairing, method, params)
  }
}))

const {
  KINGUD_MIGRATION_DESTINATION_SOURCE_KIND_UNSUPPORTED,
  abortRemoteKingudMigrationCatalog,
  commitRemoteKingudMigrationCatalog,
  readRemoteKingudMigrationCatalogState,
  stageRemoteKingudMigrationCatalog
} = await import('./kingud-migration-catalog-client')

const OPERATIONS = [
  stageRemoteKingudMigrationCatalog,
  commitRemoteKingudMigrationCatalog,
  readRemoteKingudMigrationCatalogState,
  abortRemoteKingudMigrationCatalog
]

function sshManifest(): KingudMigrationManifest {
  const unsigned = {
    version: KINGUD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-kind',
    createdAt: '2026-10-01T00:00:00.000Z',
    source: { sshTargetId: 'ssh-prod', sshTargetGeneration: 7, targetLabel: 'Production' },
    payload: { repositories: [], projectGroups: [], folderWorkspaces: [] }
  }
  return { ...unsigned, manifestSha256: computeKingudMigrationManifestSha256(unsigned) }
}

/** A WSL source, or any other `kind` as a newer or confused peer could put on the wire. */
function manifestOfKind(kind: string): KingudMigrationManifest {
  const source: KingudMigrationManifest['source'] = {
    kind: 'local-wsl',
    distro: 'Ubuntu',
    scopeRepoIds: [],
    scopeFolderWorkspaceIds: [],
    generation: 1
  }
  Object.assign(source, { kind })
  return { ...sshManifest(), source }
}

const pairingCode = encodePairingOffer({
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://127.0.0.1:46768/runtime',
  deviceToken: 'device-token',
  publicKeyB64: 'public-key',
  pairedDeviceId: 'paired-desktop'
})

beforeEach(() => {
  vi.clearAllMocks()
  sendRequest.mockResolvedValue({ ok: false, error: { code: 'x', message: 'sent' } })
  // What an older destination advertises.
  status.capabilities = [KINGUD_MIGRATION_CATALOG_RUNTIME_CAPABILITY]
})

describe('kingud migration source-kind capability gate', () => {
  it.each(OPERATIONS)('sends an SSH manifest unchanged to an older destination', async (op) => {
    await expect(op(pairingCode, sshManifest())).rejects.toThrow('sent')
    expect(sendRequest).toHaveBeenCalledTimes(1)
    const params = sendRequest.mock.calls[0][2]
    expect(params).toEqual({ manifest: sshManifest() })
    expect(JSON.stringify(params)).not.toContain('"kind"')
  })

  it.each(OPERATIONS)('never sends a WSL manifest to an older destination', async (op) => {
    await expect(op(pairingCode, manifestOfKind('local-wsl'))).rejects.toThrow(
      KINGUD_MIGRATION_DESTINATION_SOURCE_KIND_UNSUPPORTED
    )
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it.each(OPERATIONS)('sends a WSL manifest once the destination advertises it', async (op) => {
    status.capabilities = [
      KINGUD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
      KINGUD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
    ]
    await expect(op(pairingCode, manifestOfKind('local-wsl'))).rejects.toThrow('sent')
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it.each(['ssh-relay', 'wsl', ''])(
    'refuses an unregistered kind %j before any request',
    async (kind) => {
      status.capabilities = [
        KINGUD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
        KINGUD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
      ]
      await expect(
        stageRemoteKingudMigrationCatalog(pairingCode, manifestOfKind(kind))
      ).rejects.toThrow(KINGUD_MIGRATION_SOURCE_KIND_UNKNOWN)
      expect(sendRequest).not.toHaveBeenCalled()
    }
  )
})
