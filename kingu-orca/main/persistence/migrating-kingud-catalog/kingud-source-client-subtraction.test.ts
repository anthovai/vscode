import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { KingudMigrationManifest } from '../../../shared/kingud-migration-manifest'
import { kingudMigrationCutoverFixture } from '../../ssh/kingud-migration-cutover-fixture'
import { subtractKingudMigrationClientState } from './kingud-source-client-subtraction'

const worktreeId = 'repo-1::/srv/worktree'

function manifest(): KingudMigrationManifest {
  const base = kingudMigrationCutoverFixture('m-1', 'target-1', {
    environmentId: 'environment-1'
  }).manifest
  return {
    ...base,
    payload: {
      ...base.payload,
      dormantState: {
        version: 1,
        worktreeMeta: [],
        worktreeLineage: [],
        workspaceLineage: [],
        sparsePresets: [],
        retiredWorktreeNames: [],
        retiredWorktreeNamespaces: [],
        clientState: {
          clientHostedBrowserCloseIntents: [
            { sourceEnvironmentId: 'old', browserPageId: 'page-1', worktreeId, closedAt: 42 },
            { sourceEnvironmentId: 'old', browserPageId: 'page-2', worktreeId, closedAt: 43 }
          ]
        }
      }
    }
  }
}

describe('retiring client-hosted browser close intents', () => {
  it('finishes a retry after the moving write already flushed', () => {
    const state = getDefaultPersistedState('/home/test')
    state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment = {
      old: [
        { browserPageId: 'page-1', worktreeId, closedAt: 42 },
        { browserPageId: 'page-2', worktreeId, closedAt: 43 }
      ]
    }
    subtractKingudMigrationClientState(state, manifest())
    const moved = structuredClone(
      state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment
    )
    expect(() => subtractKingudMigrationClientState(state, manifest())).not.toThrow()
    expect(state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment).toEqual(moved)
  })

  it('still refuses a source intent that is gone without reaching the destination', () => {
    const state = getDefaultPersistedState('/home/test')
    state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment = {
      old: [{ browserPageId: 'page-2', worktreeId, closedAt: 43 }],
      'environment-1': [{ browserPageId: 'page-1', worktreeId, closedAt: 99 }]
    }
    expect(() => subtractKingudMigrationClientState(state, manifest())).toThrow(
      'kingud_migration_source_close_intent_changed'
    )
  })
})
