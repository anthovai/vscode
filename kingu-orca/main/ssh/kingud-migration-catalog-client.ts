import { z } from 'zod'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import {
  parseKingudMigrationCatalogAbortResult,
  parseKingudMigrationCatalogState
} from '../../shared/kingud-migration-catalog-state'
import type {
  KingudMigrationCatalogAbortResult,
  KingudMigrationCatalogState,
  KingudMigrationManifest
} from '../../shared/kingud-migration-manifest'
import {
  parseKingudMigrationSnapshotChunkResult,
  type KingudMigrationSnapshotChunkRequest,
  type KingudMigrationSnapshotChunkResult
} from '../../shared/kingud-migration-scrollback'
import {
  findUnsupportedMigrationBlobKind,
  kingudMigrationBlobKindUnsupportedBlocker,
  parseKingudMigrationBlobChunkResult,
  type KingudMigrationBlobChunkRequest,
  type KingudMigrationBlobChunkResult,
  type KingudMigrationBlobDescriptor
} from '../../shared/kingud-migration-blob-transfer'
import { parsePairingCode } from '../../shared/pairing'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { KINGUD_MIGRATION_CATALOG_RUNTIME_CAPABILITY } from '../../shared/kingud-runtime-capabilities'
import { sendRemoteRuntimeRequestWithStatusPreflight } from '../../shared/remote-runtime-client'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { hasExtraAgentArgs } from '../../shared/automation-extra-agent-args'
import { requiredKingudMigrationSourceCapability } from '../../shared/kingud-migration-source-kind'

type KingudCatalogMigrationOperation = 'abort' | 'commit' | 'stage' | 'state'

/**
 * A destination that does not offer catalog migration: an older kingud without the capability or
 * the method. This is a definite refusal; any other failure, including a lost answer, is not, and
 * the caller re-reads the catalog state before deciding anything.
 */
export const KINGUD_MIGRATION_DESTINATION_UNSUPPORTED = 'kingud_migration_destination_unsupported'
/** An older destination would strip automations' extra agent arguments, so the move is refused. */
export const KINGUD_MIGRATION_DESTINATION_EXTRA_AGENT_ARGS_UNSUPPORTED =
  'kingud_migration_destination_extra_agent_args_unsupported:Update Kingu on this host to use extra arguments.'
/** The destination does not parse this manifest's source kind; nothing was sent, so nothing staged. */
export const KINGUD_MIGRATION_DESTINATION_SOURCE_KIND_UNSUPPORTED =
  'kingud_migration_destination_source_kind_unsupported:Update Kingu on this host to move this project to it.'

type CatalogRequestOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  expectedRuntimeId?: string
}

const METHOD_BY_OPERATION: Record<KingudCatalogMigrationOperation, string> = {
  abort: 'kingud.migration.abortCatalog',
  commit: 'kingud.migration.commitCatalog',
  stage: 'kingud.migration.stageCatalog',
  state: 'kingud.migration.catalogState'
}

export function stageRemoteKingudMigrationCatalog(
  pairingCode: string,
  manifest: KingudMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<KingudMigrationCatalogState> {
  return requestCatalogState(pairingCode, 'stage', manifest, options)
}

/** `expectedBlobs` names what was moved so the destination refuses a commit missing any. */
export async function commitRemoteKingudMigrationCatalog(
  pairingCode: string,
  manifest: KingudMigrationManifest,
  options: CatalogRequestOptions & {
    expectedBlobs?: readonly KingudMigrationBlobDescriptor[]
  } = {}
): Promise<KingudMigrationCatalogState> {
  const result = await request(pairingCode, 'commit', manifest, options, options.expectedBlobs)
  return parseKingudMigrationCatalogState(result, manifest)
}

export function readRemoteKingudMigrationCatalogState(
  pairingCode: string,
  manifest: KingudMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<KingudMigrationCatalogState> {
  return requestCatalogState(pairingCode, 'state', manifest, options)
}

export async function abortRemoteKingudMigrationCatalog(
  pairingCode: string,
  manifest: KingudMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<KingudMigrationCatalogAbortResult> {
  const result = await request(pairingCode, 'abort', manifest, options)
  const parsed = parseKingudMigrationCatalogAbortResult(result, manifest)
  // Older hosts flush real aborts, but their already-absent responses prove no persistence.
  if (parsed.state === 'absent' && !parsed.aborted && parsed.durableAbsent !== true) {
    throw new Error('kingud_migration_abort_durability_unverifiable:destination_update_required')
  }
  return parsed
}

export async function stageRemoteKingudMigrationSnapshotChunk(
  pairingCode: string,
  request: KingudMigrationSnapshotChunkRequest,
  options: CatalogRequestOptions = {}
): Promise<KingudMigrationSnapshotChunkResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('kingud_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(
    pairing,
    'kingud.migration.stageSnapshotChunk',
    request,
    options
  )
  if (!response.ok) {
    throw new Error(`kingud_migration_snapshot_failed:${response.error.message}`)
  }
  return parseKingudMigrationSnapshotChunkResult(response.result, request)
}

export async function stageRemoteKingudMigrationBlobChunk(
  pairingCode: string,
  request: KingudMigrationBlobChunkRequest,
  options: CatalogRequestOptions = {}
): Promise<KingudMigrationBlobChunkResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('kingud_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(
    pairing,
    'kingud.migration.stageBlobChunk',
    request,
    options,
    false,
    null,
    // Per request: a downgraded destination must refuse the kind, never stage what it can't install.
    (capabilities) => {
      const unsupported = findUnsupportedMigrationBlobKind([request.blob], capabilities)
      if (unsupported) {
        throw new Error(kingudMigrationBlobKindUnsupportedBlocker(unsupported))
      }
    }
  )
  if (!response.ok) {
    throw new Error(`kingud_migration_blob_failed:${response.error.message}`)
  }
  return parseKingudMigrationBlobChunkResult(response.result, request)
}

const ServerRepositoriesSchema = z.object({
  repos: z.array(z.object({ id: z.string().min(1), path: z.string().min(1) }))
})

/** The projects the destination already holds, as ids and host paths, through the same preflight. */
export async function listRemoteKingudRepositories(
  pairingCode: string,
  options: CatalogRequestOptions = {}
): Promise<{ id: string; path: string }[]> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('kingud_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(pairing, 'repo.list', undefined, options)
  if (!response.ok) {
    throw new Error(`kingud_migration_repositories_failed:${response.error.message}`)
  }
  return ServerRepositoriesSchema.parse(response.result).repos.map(({ id, path }) => ({ id, path }))
}

async function requestCatalogState(
  pairingCode: string,
  operation: Exclude<KingudCatalogMigrationOperation, 'abort'>,
  manifest: KingudMigrationManifest,
  options: CatalogRequestOptions
): Promise<KingudMigrationCatalogState> {
  const result = await request(pairingCode, operation, manifest, options)
  return parseKingudMigrationCatalogState(result, manifest)
}

async function request(
  pairingCode: string,
  operation: KingudCatalogMigrationOperation,
  manifest: KingudMigrationManifest,
  options: CatalogRequestOptions,
  expectedBlobs: readonly KingudMigrationBlobDescriptor[] = []
): Promise<unknown> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('kingud_migration_pairing_code_invalid')
  }
  const carriesExtraAgentArgs =
    (operation === 'stage' || operation === 'commit') &&
    (manifest.payload.dormantState?.automations ?? []).some((automation) =>
      hasExtraAgentArgs(automation.extraAgentArgs)
    )
  const response = await sendSupportedMigrationRequest(
    pairing,
    METHOD_BY_OPERATION[operation],
    // Only with blobs: SSH and blob-free moves keep sending exactly `{ manifest }`.
    expectedBlobs.length > 0 ? { manifest, expectedBlobs } : { manifest },
    options,
    carriesExtraAgentArgs,
    // Every operation: an older destination would parse a non-SSH source as malformed or as SSH.
    requiredKingudMigrationSourceCapability(manifest.source),
    // A destination without the blob channel would strip the field and commit unchecked.
    (capabilities) => {
      const unsupported = findUnsupportedMigrationBlobKind(expectedBlobs, capabilities)
      if (unsupported) {
        throw new Error(kingudMigrationBlobKindUnsupportedBlocker(unsupported))
      }
    }
  )
  if (!response.ok) {
    throw new Error(`kingud_migration_${operation}_failed:${response.error.message}`)
  }
  return response.result
}

async function sendSupportedMigrationRequest(
  pairing: NonNullable<ReturnType<typeof parsePairingCode>>,
  method: string,
  params: unknown,
  options: CatalogRequestOptions,
  requiresExtraAgentArgs = false,
  requiredSourceCapability: string | null = null,
  assertCapabilities: (capabilities: readonly string[]) => void = () => {}
): Promise<RuntimeRpcResponse<unknown>> {
  const response = await sendRemoteRuntimeRequestWithStatusPreflight<unknown>(
    pairedRuntimeConnectionFromOffer(pairing),
    method,
    params,
    options.timeoutMs ?? 15_000,
    (status) => {
      if (!status.ok) {
        throw new Error(`kingud_migration_status_failed:${status.error.message}`)
      }
      if (
        options.expectedRuntimeId !== undefined &&
        status._meta?.runtimeId !== options.expectedRuntimeId
      ) {
        throw new Error('kingud_migration_destination_runtime_mismatch')
      }
      if (!status.result.capabilities?.includes(KINGUD_MIGRATION_CATALOG_RUNTIME_CAPABILITY)) {
        throw new Error(KINGUD_MIGRATION_DESTINATION_UNSUPPORTED)
      }
      if (
        requiresExtraAgentArgs &&
        !status.result.capabilities?.includes(AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY)
      ) {
        throw new Error(KINGUD_MIGRATION_DESTINATION_EXTRA_AGENT_ARGS_UNSUPPORTED)
      }
      if (
        requiredSourceCapability !== null &&
        !status.result.capabilities?.includes(requiredSourceCapability)
      ) {
        throw new Error(KINGUD_MIGRATION_DESTINATION_SOURCE_KIND_UNSUPPORTED)
      }
      assertCapabilities(status.result.capabilities ?? [])
    },
    undefined,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
    options.signal
  )
  if (!response.ok && response.error.code === 'method_not_found') {
    throw new Error(KINGUD_MIGRATION_DESTINATION_UNSUPPORTED)
  }
  if (
    options.expectedRuntimeId !== undefined &&
    response._meta?.runtimeId !== options.expectedRuntimeId
  ) {
    throw new Error('kingud_migration_destination_runtime_mismatch')
  }
  return response
}
