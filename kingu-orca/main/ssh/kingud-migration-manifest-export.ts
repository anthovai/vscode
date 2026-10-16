/**
 * The signed manifest a relay-hosted SSH target's state is exported as.
 *
 * Reads only: the catalog rows the target owns and the dormant state that references them, copied
 * out of the profile-state store. The source keeps every row; retiring it happens only after the
 * destination has verified and imported this exact manifest.
 */
import { randomUUID } from 'node:crypto'
import {
  KINGUD_MIGRATION_MANIFEST_VERSION,
  parseKingudMigrationManifest,
  type KingudMigrationCatalogPayload,
  type KingudMigrationDormantStatePayload,
  type KingudMigrationManifest
} from '../../shared/kingud-migration-manifest'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { collectKingudMigrationSourceCatalog } from '../persistence/migrating-kingud-catalog/kingud-source-catalog'
import { computeKingudMigrationManifestSha256 } from '../kingud/kingud-migration-manifest-digest'
import {
  IDENTITY_KINGUD_MIGRATION_PATH_REWRITER,
  rewriteKingudMigrationPayloadPaths,
  type KingudMigrationPathRewriter
} from './kingud-migration-path-rewrite'

export type KingudMigrationExportStore = Pick<
  Store,
  | 'collectKingudMigrationSourceDormantState'
  | 'getFolderWorkspaces'
  | 'getProjectGroups'
  | 'getRepos'
>

export type KingudMigrationManifestExportOptions = {
  migrationId?: string
  now?: () => Date
  destinationEnvironmentId?: string
  /** Only these rows: a re-export of what earlier migrations of the host already moved. */
  onlyCatalog?: KingudMigrationCatalogIds
  /** Maps source paths to destination paths before signing; identity for an SSH host. */
  rewrite?: KingudMigrationPathRewriter
}

export function createKingudMigrationManifest(
  store: KingudMigrationExportStore,
  target: SshTarget,
  options: KingudMigrationManifestExportOptions = {}
): KingudMigrationManifest {
  const rewrite = options.rewrite ?? IDENTITY_KINGUD_MIGRATION_PATH_REWRITER
  const sourcePayload = restrictCatalog(
    collectKingudMigrationSourceCatalog(store, target),
    options.onlyCatalog
  )
  const source = {
    sshTargetId: target.id,
    sshTargetGeneration: target.generation ?? null,
    targetLabel: target.label
  }
  const dormantState = store.collectKingudMigrationSourceDormantState(
    source,
    sourcePayload,
    options.destinationEnvironmentId
  )
  // After collection: dormant state is selected by the source's own paths and ids.
  const payload = rewriteKingudMigrationPayloadPaths(
    { ...sourcePayload, ...(hasDormantState(dormantState) ? { dormantState } : {}) },
    rewrite
  )
  const unsigned = {
    version: KINGUD_MIGRATION_MANIFEST_VERSION,
    migrationId: options.migrationId ?? randomUUID(),
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    source,
    payload,
    ...(options.destinationEnvironmentId
      ? { destinationEnvironmentId: options.destinationEnvironmentId }
      : {})
  }
  return parseKingudMigrationManifest({
    ...unsigned,
    manifestSha256: computeKingudMigrationManifestSha256(unsigned)
  })
}

export type KingudMigrationCatalogIds = {
  repositoryIds: ReadonlySet<string>
  folderWorkspaceIds: ReadonlySet<string>
  projectGroupIds: ReadonlySet<string>
}

export function kingudMigrationCatalogIds(
  payloads: readonly KingudMigrationCatalogPayload[]
): KingudMigrationCatalogIds {
  return {
    repositoryIds: new Set(payloads.flatMap((p) => p.repositories.map((row) => row.id))),
    folderWorkspaceIds: new Set(payloads.flatMap((p) => p.folderWorkspaces.map((row) => row.id))),
    projectGroupIds: new Set(payloads.flatMap((p) => p.projectGroups.map((row) => row.id)))
  }
}

function restrictCatalog(
  payload: KingudMigrationCatalogPayload,
  ids: KingudMigrationCatalogIds | undefined
): KingudMigrationCatalogPayload {
  if (!ids) {
    return payload
  }
  return {
    repositories: payload.repositories.filter((row) => ids.repositoryIds.has(row.id)),
    folderWorkspaces: payload.folderWorkspaces.filter((row) => ids.folderWorkspaceIds.has(row.id)),
    projectGroups: payload.projectGroups.filter((row) => ids.projectGroupIds.has(row.id))
  }
}

function hasDormantState(state: KingudMigrationDormantStatePayload): boolean {
  return (
    state.worktreeMeta.length > 0 ||
    state.worktreeLineage.length > 0 ||
    state.workspaceLineage.length > 0 ||
    state.sparsePresets.length > 0 ||
    state.retiredWorktreeNames.length > 0 ||
    state.retiredWorktreeNamespaces.length > 0 ||
    state.workspaceSession !== undefined ||
    (state.terminalScrollbackSnapshots?.length ?? 0) > 0 ||
    (state.automations?.length ?? 0) > 0 ||
    (state.automationRuns?.length ?? 0) > 0 ||
    (state.clientState !== undefined && Object.keys(state.clientState).length > 0)
  )
}
