/** Checks run before every stage and commit: the fenced source is still what the journal says. */
import { createHash } from 'node:crypto'
import {
  serializeKingudMigrationValue,
  type KingudMigrationManifest
} from '../../shared/kingud-migration-manifest'
import type { KingudMigrationSourceCutover } from '../../shared/kingud-migration-source-cutover'
import { createKingudMigrationManifest } from './kingud-migration-manifest-export'
import { resolveKingudMigrationFence } from './kingud-migration-source-fence'
import { confirmKingudMigrationTerminalsUnderFence } from './kingud-migration-terminal-gate'
import { collectUntransferredDependentBlockers } from './ssh-target-kingud-dependents'
import type { KingudMigrationPreflightStore } from './ssh-target-kingud-preflight'

export function assertKingudMigrationSourceUnchanged(
  context: { userDataPath: string; store: KingudMigrationPreflightStore },
  cutover: KingudMigrationSourceCutover
): void {
  const target = context.store.getSshTarget(cutover.sshTargetId)
  const fence = target ? resolveKingudMigrationFence(context.userDataPath, target) : null
  if (!target || fence?.state !== 'fenced' || fence.cutover.migrationId !== cutover.migrationId) {
    throw new Error('kingud_migration_source_fence_lost')
  }
  // Same id, time and destination as the journaled export: any difference is a source change.
  const current = createKingudMigrationManifest(context.store, target, {
    migrationId: cutover.migrationId,
    destinationEnvironmentId: cutover.destinationEnvironmentId,
    now: () => new Date(cutover.manifest.createdAt)
  })
  if (frozenSourceDigest(current) !== frozenSourceDigest(cutover.manifest)) {
    throw new Error('kingud_migration_source_changed')
  }
  if (collectUntransferredDependentBlockers(context.store, cutover.manifest).length > 0) {
    throw new Error('kingud_migration_source_dependencies_present')
  }
  const terminals = confirmKingudMigrationTerminalsUnderFence(
    context.store,
    target.id,
    cutover.bridgedPtyIds
      ? {
          verdict: 'bridged',
          relayVerdict: 'unverifiable',
          bridgedPtyIds: cutover.bridgedPtyIds,
          hostTerminals: 0
        }
      : { verdict: 'exited', provenPtyIds: cutover.provenPtyIds }
  )
  if (terminals.verdict === 'live' || terminals.verdict === 'unverifiable') {
    throw new Error(`kingud_migration_source_terminals_${terminals.verdict}`)
  }
}

/**
 * The manifest minus what the UI rewrites as the user works (tabs, focus, routing): the server
 * gets those as journaled, and a tab reorder mid-conversion must not fail the move.
 */
function frozenSourceDigest(manifest: KingudMigrationManifest): string {
  const { manifestSha256: _digest, payload, ...rest } = manifest
  const {
    version: _version,
    workspaceSession: _session,
    clientState: _client,
    // Retained for the transfer, so a tab closed mid-move still sends its journaled bytes.
    terminalScrollbackSnapshots: _snapshots,
    ...dormant
  } = payload.dormantState ?? {}
  // Export omits an empty dormant payload, so UI state alone can make one appear.
  const empty = Object.values(dormant).every(
    (value) => value === undefined || (Array.isArray(value) && value.length === 0)
  )
  const frozen = { ...rest, payload: { ...payload, dormantState: empty ? undefined : dormant } }
  return createHash('sha256').update(serializeKingudMigrationValue(frozen)).digest('hex')
}
