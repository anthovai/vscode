import type {
  KingudMigrationDormantStatePayload,
  KingudMigrationManifest
} from '../../../shared/kingud-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SparsePreset } from '../../../shared/worktree/create-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { omitDefaultWorktreeMetaFields } from '../../../shared/worktree/meta-persisted-defaults'
import { assertKingudDestinationCanonicalMetadata } from './kingud-destination-worktree-metadata'
import { assertSameValue } from './kingud-catalog-row-identity'
import {
  mergeRetiredNameRegistries,
  type RetiredNameRegistry
} from '../../../shared/worktree/retired-name-registry'
import { recordRetirementNamespaceRegistry } from '../../worktree-retirement-namespace'
import {
  applyPreparedKingudMigrationWorkspaceSession,
  prepareKingudMigrationWorkspaceSession,
  type PreparedKingudMigrationWorkspaceSession
} from './kingud-destination-workspace-session'
import {
  applyPreparedKingudMigrationAutomationState,
  prepareKingudMigrationAutomationState,
  type PreparedKingudMigrationAutomationState
} from './kingud-destination-automation-state'
import {
  applyPreparedKingudMigrationClientState,
  prepareKingudMigrationClientState,
  type PreparedKingudMigrationClientState
} from './kingud-destination-client-state'

type KeyedRow<T> = { key: string; value: T }
type RegistryUpdate = { key: string; value: RetiredNameRegistry }

export type PreparedKingudMigrationDormantState = {
  payload: KingudMigrationDormantStatePayload | undefined
  newWorktreeMeta: KeyedRow<WorktreeMeta>[]
  newWorktreeLineage: KeyedRow<WorktreeLineage>[]
  newWorkspaceLineage: KeyedRow<WorkspaceLineage>[]
  newSparsePresets: SparsePreset[]
  retiredNameUpdates: RegistryUpdate[]
  retirementNamespaceUpdates: RegistryUpdate[]
  workspaceSession: PreparedKingudMigrationWorkspaceSession
  automationState: PreparedKingudMigrationAutomationState
  clientState: PreparedKingudMigrationClientState
}

export function prepareKingudMigrationDormantState(
  manifest: KingudMigrationManifest,
  state: PersistedState
): PreparedKingudMigrationDormantState {
  const payload = manifest.payload.dormantState
  if (!payload) {
    return emptyPreparedDormantState()
  }
  assertKingudDestinationCanonicalMetadata(state, payload.worktreeMeta)
  const worktreeMeta = payload.worktreeMeta.map((entry) => ({
    key: entry.worktreeId,
    value: structuredClone(entry.meta)
  }))
  const worktreeLineage = payload.worktreeLineage.map((entry) => ({
    key: entry.worktreeId,
    value: structuredClone(entry.lineage)
  }))
  const workspaceLineage = payload.workspaceLineage.map((entry) => ({
    key: entry.childWorkspaceKey,
    value: structuredClone(entry.lineage)
  }))
  const existingPresets = new Map(
    Object.values(state.sparsePresetsByRepo)
      .flat()
      .map((preset) => [sparsePresetKey(preset), preset])
  )
  const newSparsePresets = payload.sparsePresets.filter((preset) => {
    const existing = existingPresets.get(sparsePresetKey(preset))
    if (!existing) {
      return true
    }
    assertSameValue(existing, preset, `sparse_preset:${preset.repoId}:${preset.id}`)
    return false
  })
  return {
    payload,
    newWorktreeMeta: selectNewKeyedRows(
      worktreeMeta,
      state.worktreeMeta,
      'worktree_meta',
      omitDefaultWorktreeMetaFields
    ),
    newWorktreeLineage: selectNewKeyedRows(
      worktreeLineage,
      state.worktreeLineageById,
      'worktree_lineage'
    ),
    newWorkspaceLineage: selectNewKeyedRows(
      workspaceLineage,
      state.workspaceLineageByChildKey,
      'workspace_lineage'
    ),
    newSparsePresets,
    retiredNameUpdates: payload.retiredWorktreeNames.map((entry) => ({
      key: entry.repoId,
      value: mergeRetiredNameRegistries(
        state.retiredWorktreeNamesByRepo?.[entry.repoId] ?? { exhaustedTiers: 0, names: [] },
        entry.registry
      )
    })),
    retirementNamespaceUpdates: payload.retiredWorktreeNamespaces.map((entry) => ({
      key: entry.namespaceKey,
      value: mergeRetiredNameRegistries(
        state.retiredWorktreeNamesByNamespace?.[entry.namespaceKey] ?? {
          exhaustedTiers: 0,
          names: []
        },
        entry.registry
      )
    })),
    workspaceSession: prepareKingudMigrationWorkspaceSession(payload.workspaceSession, state),
    automationState: prepareKingudMigrationAutomationState(
      payload.automations,
      payload.automationRuns,
      state
    ),
    clientState: prepareKingudMigrationClientState(payload.clientState, state)
  }
}

export function applyPreparedKingudMigrationDormantState(
  prepared: PreparedKingudMigrationDormantState,
  state: PersistedState
): void {
  for (const entry of prepared.newWorktreeMeta) {
    state.worktreeMeta[entry.key] = entry.value
  }
  for (const entry of prepared.newWorktreeLineage) {
    state.worktreeLineageById[entry.key] = entry.value
  }
  for (const entry of prepared.newWorkspaceLineage) {
    state.workspaceLineageByChildKey[entry.key] = entry.value
  }
  for (const preset of prepared.newSparsePresets) {
    state.sparsePresetsByRepo[preset.repoId] = [
      ...(state.sparsePresetsByRepo[preset.repoId] ?? []),
      preset
    ]
  }
  if (prepared.retiredNameUpdates.length > 0) {
    state.retiredWorktreeNamesByRepo ??= {}
    for (const entry of prepared.retiredNameUpdates) {
      state.retiredWorktreeNamesByRepo[entry.key] = entry.value
    }
  }
  if (prepared.retirementNamespaceUpdates.length > 0) {
    state.retiredWorktreeNamesByNamespace ??= {}
    for (const entry of prepared.retirementNamespaceUpdates) {
      recordRetirementNamespaceRegistry(
        state.retiredWorktreeNamesByNamespace,
        entry.key,
        entry.value
      )
    }
  }
  applyPreparedKingudMigrationWorkspaceSession(prepared.workspaceSession, state)
  applyPreparedKingudMigrationAutomationState(prepared.automationState, state)
  applyPreparedKingudMigrationClientState(prepared.clientState, state)
}

function selectNewKeyedRows<T>(
  incoming: KeyedRow<T>[],
  existing: Record<string, T>,
  label: string,
  canonicalize: (value: T) => T = (value) => value
): KeyedRow<T>[] {
  return incoming.filter((entry) => {
    const current = existing[entry.key]
    if (current === undefined) {
      return true
    }
    assertSameValue(canonicalize(current), canonicalize(entry.value), `${label}:${entry.key}`)
    return false
  })
}

const sparsePresetKey = (preset: Pick<SparsePreset, 'id' | 'repoId'>): string =>
  `${preset.repoId}\0${preset.id}`

function emptyPreparedDormantState(): PreparedKingudMigrationDormantState {
  return {
    payload: undefined,
    newWorktreeMeta: [],
    newWorktreeLineage: [],
    newWorkspaceLineage: [],
    newSparsePresets: [],
    retiredNameUpdates: [],
    retirementNamespaceUpdates: [],
    workspaceSession: { incoming: undefined, merged: undefined },
    automationState: {
      incomingAutomations: [],
      incomingRuns: [],
      newAutomations: [],
      newRuns: []
    },
    clientState: {
      incoming: undefined,
      mobileSelections: {},
      uiRouting: undefined
    }
  }
}
