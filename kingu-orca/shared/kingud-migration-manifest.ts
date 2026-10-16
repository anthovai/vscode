import type { FolderWorkspace } from './folder-workspace-types'
import type { Automation, AutomationRun } from './automations-types'
import type { KingudMigrationManifestVersion } from './kingud-migration-manifest-validation'
import type { ProjectGroup } from './project-group-types'
import type { Repo } from './repo-types'
import type { SparsePreset } from './worktree/create-types'
import type { WorkspaceLineage, WorktreeLineage } from './worktree/lineage-types'
import type { WorktreeMeta } from './worktree/meta-types'
import type { RetiredNameRegistry } from './worktree/retired-name-registry'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import type { KingudMigrationClientStatePayload } from './kingud-migration-client-state'
import type {
  KingudMigrationSnapshotUploadState,
  KingudMigrationTerminalScrollbackSnapshot
} from './kingud-migration-scrollback'
import type { KingudMigrationBlobUploadState } from './kingud-migration-blob-transfer'

export {
  MAX_KINGUD_MIGRATION_FOLDER_WORKSPACES,
  MAX_KINGUD_MIGRATION_IMPORT_RECEIPTS,
  MAX_KINGUD_MIGRATION_MANIFEST_BYTES,
  MAX_KINGUD_MIGRATION_PROJECT_GROUPS,
  MAX_KINGUD_MIGRATION_REPOSITORIES,
  normalizeKingudMigrationImportReceipts,
  KINGUD_MIGRATION_MANIFEST_VERSION,
  parseKingudMigrationManifest
} from './kingud-migration-manifest-validation'
export {
  MAX_KINGUD_MIGRATION_DORMANT_NAMESPACES,
  MAX_KINGUD_MIGRATION_DORMANT_ROWS,
  KINGUD_MIGRATION_DORMANT_STATE_VERSION
} from './kingud-migration-dormant-state-validation'
export {
  MAX_KINGUD_MIGRATION_STAGED_CATALOGS,
  normalizeKingudMigrationStagedCatalogs
} from './kingud-migration-staged-catalog-validation'
import { isRecord } from './kingud-migration-manifest-fields'

/** The relay-era SSH source: on the wire it never carries `kind` (see kingud-migration-source-kind). */
export type KingudMigrationSshManifestSource = {
  sshTargetId: string
  sshTargetGeneration: number | null
  targetLabel: string
}

/**
 * Local WSL projects on this desktop, moving to the kingud that runs inside their distro. Scope is
 * explicit so a destination never infers it from paths, and `generation` orders delta moves.
 */
export type KingudMigrationLocalWslManifestSource = {
  kind: 'local-wsl'
  distro: string
  /** The distro's registry id, when known: a re-registered distro of the same name is another one. */
  distroGuid?: string
  scopeRepoIds: string[]
  scopeFolderWorkspaceIds: string[]
  generation: number
}

export type KingudMigrationManifestSource =
  | KingudMigrationSshManifestSource
  | KingudMigrationLocalWslManifestSource

export type KingudMigrationCatalogPayload = {
  repositories: Repo[]
  projectGroups: ProjectGroup[]
  folderWorkspaces: FolderWorkspace[]
  dormantState?: KingudMigrationDormantStatePayload
}

export type KingudMigrationDormantWorktreeMeta = {
  sourceKey: string
  worktreeId: string
  meta: WorktreeMeta
}

export type KingudMigrationDormantWorktreeLineage = {
  sourceKey: string
  worktreeId: string
  lineage: WorktreeLineage
}

export type KingudMigrationDormantWorkspaceLineage = {
  sourceKey: string
  childWorkspaceKey: string
  lineage: WorkspaceLineage
}

export type KingudMigrationDormantRetiredNames = {
  repoId: string
  registry: RetiredNameRegistry
}

export type KingudMigrationDormantRetirementNamespace = {
  sourceNamespaceKeys: string[]
  namespaceKey: string
  registry: RetiredNameRegistry
}

export type KingudMigrationDormantStatePayload = {
  version: 1
  worktreeMeta: KingudMigrationDormantWorktreeMeta[]
  worktreeLineage: KingudMigrationDormantWorktreeLineage[]
  workspaceLineage: KingudMigrationDormantWorkspaceLineage[]
  sparsePresets: SparsePreset[]
  retiredWorktreeNames: KingudMigrationDormantRetiredNames[]
  retiredWorktreeNamespaces: KingudMigrationDormantRetirementNamespace[]
  workspaceSession?: WorkspaceSessionState
  terminalScrollbackSnapshots?: KingudMigrationTerminalScrollbackSnapshot[]
  automations?: Automation[]
  automationRuns?: AutomationRun[]
  /** Client-owned durable intent projected to the destination authority. */
  clientState?: KingudMigrationClientStatePayload
}

export type KingudMigrationManifest = {
  version: KingudMigrationManifestVersion
  migrationId: string
  createdAt: string
  source: KingudMigrationManifestSource
  payload: KingudMigrationCatalogPayload
  /** Destination runtime identity used to re-key desktop routing after commit. */
  destinationEnvironmentId?: string
  manifestSha256: string
}

export type KingudMigrationImportReceipt = {
  version: KingudMigrationManifestVersion
  migrationId: string
  manifestSha256: string
  source: KingudMigrationManifestSource
  importedAt: string
  repositoryIds: string[]
  projectGroupIds: string[]
  folderWorkspaceIds: string[]
}

export type KingudMigrationStagedCatalog = {
  version: KingudMigrationManifestVersion
  manifest: KingudMigrationManifest
  stagedAt: string
}

export type KingudMigrationCatalogState =
  | {
      state: 'absent'
      migrationId: string
      manifestSha256: string
    }
  | {
      state: 'staged'
      migrationId: string
      manifestSha256: string
      stagedAt: string
      snapshotUploads?: KingudMigrationSnapshotUploadState[]
      /** Blobs staged so far; absent from hosts without the blob channel. */
      blobUploads?: KingudMigrationBlobUploadState[]
    }
  | {
      state: 'committed'
      migrationId: string
      manifestSha256: string
      receipt: KingudMigrationImportReceipt
    }

export type KingudMigrationCatalogAbortResult = KingudMigrationCatalogState & {
  aborted: boolean
  durableAbsent?: true
}

export function kingudMigrationManifestHashInput(
  manifest: Omit<KingudMigrationManifest, 'manifestSha256'>
): string {
  return serializeKingudMigrationValue(manifest)
}

export function serializeKingudMigrationValue(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value))
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue)
  }
  if (!isRecord(value)) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalizeJsonValue(entry)])
  )
}
