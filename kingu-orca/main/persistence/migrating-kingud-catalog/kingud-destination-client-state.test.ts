import { describe, expect, it } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { KingudMigrationClientStatePayload } from '../../../shared/kingud-migration-client-state'
import {
  applyPreparedKingudMigrationClientState,
  prepareKingudMigrationClientState
} from './kingud-destination-client-state'

function state(): PersistedState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a minimal persisted state; the code under test reads only the client-state fields set here.
  return {
    ui: {
      lastActiveRepoId: null,
      lastActiveWorktreeId: null,
      filterRepoIds: [],
      showDotfilesByWorktree: {},
      setupScriptPromptDismissedRepoIds: [],
      manualRepoOrder: [],
      workspaceHostScope: undefined,
      visibleWorkspaceHostIds: null,
      workspaceHostOrder: [],
      automationHostFilter: { kind: 'all' },
      acknowledgedAgentsByPaneKey: {}
    }
  } as unknown as PersistedState
}

const incoming: KingudMigrationClientStatePayload = {
  mobileClientTabSelectionsByDeviceId: {
    phone: {
      'repo-1::/worktree': {
        activeTabId: 'tab-1',
        activeGroupId: null,
        activeTabIdByGroupId: {}
      }
    }
  },
  uiRouting: {
    lastActiveRepoId: 'repo-1',
    lastActiveWorktreeId: 'repo-1::/worktree',
    filterRepoIds: ['repo-1'],
    showDotfilesByWorktree: { 'repo-1::/worktree': false },
    manualRepoOrder: [{ hostId: 'local', repoId: 'repo-1' }]
  }
}

describe('destination client-state migration', () => {
  it('applies selections and routing while preserving unrelated device state', () => {
    const destination = state()
    destination.mobileClientTabSelectionsByDeviceId = {
      tablet: {
        'repo-other::/worktree': {
          activeTabId: null,
          activeGroupId: null,
          activeTabIdByGroupId: {}
        }
      }
    }
    const prepared = prepareKingudMigrationClientState(incoming, destination)
    applyPreparedKingudMigrationClientState(prepared, destination)

    expect(destination.mobileClientTabSelectionsByDeviceId).toMatchObject({
      phone: incoming.mobileClientTabSelectionsByDeviceId?.phone,
      tablet: expect.any(Object)
    })
    expect(destination.ui).toMatchObject({
      lastActiveRepoId: 'repo-1',
      lastActiveWorktreeId: 'repo-1::/worktree',
      filterRepoIds: ['repo-1'],
      showDotfilesByWorktree: { 'repo-1::/worktree': false }
    })
  })

  it("keeps a device's selections for workspaces outside the import", () => {
    const destination = state()
    const kept = { activeTabId: 'kept', activeGroupId: null, activeTabIdByGroupId: {} }
    destination.mobileClientTabSelectionsByDeviceId = { phone: { 'old::/workspace': kept } }
    applyPreparedKingudMigrationClientState(
      prepareKingudMigrationClientState(incoming, destination),
      destination
    )
    expect(destination.mobileClientTabSelectionsByDeviceId?.phone).toEqual({
      'old::/workspace': kept,
      ...incoming.mobileClientTabSelectionsByDeviceId?.phone
    })
  })

  it('rejects a conflicting destination selection before publication', () => {
    const destination = state()
    destination.mobileClientTabSelectionsByDeviceId = {
      phone: {
        'repo-1::/worktree': {
          activeTabId: 'different-tab',
          activeGroupId: null,
          activeTabIdByGroupId: {}
        }
      }
    }
    expect(() => prepareKingudMigrationClientState(incoming, destination)).toThrow(
      'kingud_migration_client_state_conflict:mobile'
    )
  })

  it('rejects non-default UI routing conflicts', () => {
    const destination = state()
    destination.ui.lastActiveRepoId = 'other-repo'
    expect(() => prepareKingudMigrationClientState(incoming, destination)).toThrow(
      'kingud_migration_client_state_conflict:ui:lastActiveRepoId'
    )
  })
})
