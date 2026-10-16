import type { z } from 'zod'
import {
  KingudMigrationCatalogParams,
  KingudMigrationCommitCatalogParams
} from '../../../../shared/rpc-contract/kingud-migration-params'
import { parseKingudMigrationManifest } from '../../../../shared/kingud-migration-manifest'
import { KingudMigrationSnapshotChunkRequestSchema } from '../../../../shared/kingud-migration-scrollback'
import { KingudMigrationBlobChunkRequestSchema } from '../../../../shared/kingud-migration-blob-transfer'
import { assertKingudMigrationManifestDigest } from '../../../kingud/kingud-migration-manifest-digest'
import { assertKingudMigrationSourceServedHere } from '../../../kingud/kingud-migration-wsl-destination'
import { defineMethod, type RpcContext } from '../core'

export const KINGUD_MIGRATION_METHODS = [
  defineMethod({
    name: 'kingud.migration.stageCatalog',
    permission: 'host-admin',
    params: KingudMigrationCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.stageKingudMigrationCatalog(migrationManifest(params), {
        signal: context.signal
      })
    }
  }),
  defineMethod({
    name: 'kingud.migration.commitCatalog',
    permission: 'host-admin',
    params: KingudMigrationCommitCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.commitStagedKingudMigrationCatalog(migrationManifest(params), {
        signal: context.signal,
        ...(params.expectedBlobs ? { expectedBlobs: params.expectedBlobs } : {})
      })
    }
  }),
  defineMethod({
    name: 'kingud.migration.stageSnapshotChunk',
    permission: 'host-admin',
    params: KingudMigrationSnapshotChunkRequestSchema,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.stageKingudMigrationSnapshotChunk(params)
    }
  }),
  // A separate method, not a field on stageSnapshotChunk: an older host would strip the field and
  // stage the bytes as a snapshot.
  defineMethod({
    name: 'kingud.migration.stageBlobChunk',
    permission: 'host-admin',
    params: KingudMigrationBlobChunkRequestSchema,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.stageKingudMigrationBlobChunk(params)
    }
  }),
  defineMethod({
    name: 'kingud.migration.abortCatalog',
    permission: 'host-admin',
    params: KingudMigrationCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.abortStagedKingudMigrationCatalog(migrationManifest(params), {
        signal: context.signal
      })
    }
  }),
  defineMethod({
    name: 'kingud.migration.catalogState',
    permission: 'host-admin',
    params: KingudMigrationCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.getKingudMigrationCatalogState(migrationManifest(params))
    }
  })
]

function migrationManifest(params: z.infer<typeof KingudMigrationCatalogParams>) {
  const manifest = parseKingudMigrationManifest(params.manifest)
  // Raw, not parsed: parsing drops fields this host predates, which a newer client signed.
  assertKingudMigrationManifestDigest(params.manifest)
  assertKingudMigrationSourceServedHere(manifest.source)
  return manifest
}

function requireMigrationRuntimeClient(context: RpcContext): void {
  if (context.clientKind !== 'runtime' || !context.pairedDeviceId) {
    throw new Error('kingud_migration_runtime_client_required')
  }
}
