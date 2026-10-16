/**
 * Staging, committing and aborting a dormant migration on its destination kingud.
 *
 * The source stays authoritative until the destination proves a commit: before every stage and
 * commit the fenced source must still export the journaled manifest and carry no state the
 * manifest cannot. A lost answer is never read as success or as absence; the destination's
 * catalog state is re-read, and only that observation moves the journal, which is on disk before
 * anything is returned. A committed destination is never released.
 */
import type {
  KingudMigrationCatalogAbortResult,
  KingudMigrationCatalogState,
  KingudMigrationManifest
} from '../../shared/kingud-migration-manifest'
import type {
  KingudMigrationSnapshotChunkRequest,
  KingudMigrationSnapshotChunkResult
} from '../../shared/kingud-migration-scrollback'
import type {
  KingudMigrationSourceCutover,
  KingudMigrationSourceCutoverPhase
} from '../../shared/kingud-migration-source-cutover'
import { resolveDurableKingudCatalogMutation } from './kingud-catalog-durable-mutation'
import { KINGUD_MIGRATION_DESTINATION_UNSUPPORTED } from './kingud-migration-catalog-client'
import {
  listKingudMigrationSourceCutovers,
  writeKingudMigrationSourceCutover
} from './kingud-migration-cutover-journal'
import type { KingudMigrationSourceCutoverPort } from './kingud-migration-source'
import {
  transferKingudMigrationSnapshots,
  type KingudMigrationSnapshotSource
} from './kingud-migration-snapshot-coordinator'
import type { KingudMigrationPreflightStore } from './ssh-target-kingud-preflight'
import { sshRelayMigrationCutoverPort } from './kingud-migration-ssh-relay-source'
import type { SshTargetKingudClaims } from './ssh-target-kingud-claims'

/** The destination's catalog operations, served by the T6-9 kingud.migration.* client. */
export type KingudMigrationDestinationCatalog = {
  readState: (manifest: KingudMigrationManifest) => Promise<KingudMigrationCatalogState>
  stage: (manifest: KingudMigrationManifest) => Promise<KingudMigrationCatalogState>
  commit: (manifest: KingudMigrationManifest) => Promise<KingudMigrationCatalogState>
  abort: (manifest: KingudMigrationManifest) => Promise<KingudMigrationCatalogAbortResult>
  stageChunk: (
    request: KingudMigrationSnapshotChunkRequest
  ) => Promise<KingudMigrationSnapshotChunkResult>
}

export type KingudMigrationCutoverContext = {
  userDataPath: string
  store: KingudMigrationPreflightStore & KingudMigrationSnapshotSource
  claims: SshTargetKingudClaims
  destination: KingudMigrationDestinationCatalog
  /** Rebuilt for every check when `store` is a copy that would never see a later edit. */
  freshSource?: () => KingudMigrationPreflightStore
  /** The fenced source; defaults to the relay-era SSH target the journal names. */
  source?: KingudMigrationSourceCutoverPort
  now?: () => Date
}

function cutoverSource(context: KingudMigrationCutoverContext): KingudMigrationSourceCutoverPort {
  return context.source ?? sshRelayMigrationCutoverPort(context)
}

export async function stageKingudMigrationDestination(
  context: KingudMigrationCutoverContext,
  migrationId: string
): Promise<KingudMigrationSourceCutover> {
  let cutover = requireCutover(context.userDataPath, migrationId)
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    return cutover
  }
  assertSourceUnchanged(context, cutover)
  const { destination } = context
  const read = await destination.readState(cutover.manifest)
  const state =
    read.state === 'committed'
      ? await confirmDurableCommit(destination, cutover.manifest)
      : await resolveDurableKingudCatalogMutation(
          () => destination.stage(cutover.manifest),
          () => destination.readState(cutover.manifest),
          (observed) => observed.state !== 'absent'
        )
  cutover = recordObservedState(context, cutover, state)
  if (state.state === 'staged') {
    await transferKingudMigrationSnapshots({
      source: context.store,
      manifest: cutover.manifest,
      state,
      destination: { readState: destination.readState, stageChunk: destination.stageChunk }
    })
  }
  return cutover
}

export async function commitKingudMigrationDestination(
  context: KingudMigrationCutoverContext,
  migrationId: string
): Promise<KingudMigrationSourceCutover> {
  const staged = await stageKingudMigrationDestination(context, migrationId)
  if (staged.phase !== 'destination-staged') {
    return staged
  }
  assertSourceUnchanged(context, staged)
  const { destination } = context
  // Why re-read: a lost commit reply may hide a commit that landed; the read decides.
  const state = await resolveDurableKingudCatalogMutation(
    () => destination.commit(staged.manifest),
    () => destination.readState(staged.manifest),
    (observed) => observed.state === 'committed'
  )
  if (state.state !== 'committed') {
    throw new Error(`kingud_migration_commit_not_committed:${state.state}`)
  }
  return recordObservedState(context, staged, state)
}

export type KingudMigrationAbortResult =
  | { outcome: 'released'; evidence: 'catalog-absent' | 'destination-unsupported' }
  | { outcome: 'refused'; code: string; reason: string }

/**
 * Releases the source only on proof the destination holds nothing of this migration. `release`
 * defaults to dropping the fence and journal; a delta move keeps the fence instead.
 */
export async function abortKingudMigrationCutover(
  context: KingudMigrationCutoverContext,
  migrationId: string,
  release: (cutover: KingudMigrationSourceCutover) => Promise<void> = (cutover) =>
    cutoverSource(context).releaseFence(cutover)
): Promise<KingudMigrationAbortResult> {
  const cutover = requireCutover(context.userDataPath, migrationId)
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    return committedRefusal()
  }
  const { destination } = context
  let state: KingudMigrationCatalogState
  try {
    state = await destination.readState(cutover.manifest)
  } catch (error) {
    // Unsupported means nothing could have been staged, but only if nothing ever was.
    if (isDestinationUnsupported(error) && cutover.phase === 'source-fenced') {
      await release(cutover)
      return { outcome: 'released', evidence: 'destination-unsupported' }
    }
    throw error
  }
  if (state.state !== 'committed') {
    state = await abortWithRecovery(destination, cutover.manifest)
  }
  if (state.state === 'committed') {
    recordObservedState(context, cutover, await confirmDurableCommit(destination, cutover.manifest))
    return committedRefusal()
  }
  if (state.state !== 'absent') {
    throw new Error(`kingud_migration_abort_not_absent:${state.state}`)
  }
  await release(cutover)
  return { outcome: 'released', evidence: 'catalog-absent' }
}

/**
 * A committed read may come from memory the server never flushed; only commit()'s acknowledgement,
 * which flushes before it answers, may move the journal to committed.
 */
async function confirmDurableCommit(
  destination: KingudMigrationDestinationCatalog,
  manifest: KingudMigrationManifest
): Promise<KingudMigrationCatalogState> {
  const state = await destination.commit(manifest)
  if (state.state !== 'committed') {
    throw new Error(`kingud_migration_commit_not_committed:${state.state}`)
  }
  return state
}

function assertSourceUnchanged(
  context: KingudMigrationCutoverContext,
  cutover: KingudMigrationSourceCutover
): void {
  cutoverSource(context).verifyFence(cutover)
}

/** Moves the journal to what the destination reported; durable before it returns. */
function recordObservedState(
  context: KingudMigrationCutoverContext,
  cutover: KingudMigrationSourceCutover,
  state: KingudMigrationCatalogState
): KingudMigrationSourceCutover {
  if (state.state === 'absent') {
    throw new Error('kingud_migration_destination_catalog_absent')
  }
  if (
    state.migrationId !== cutover.migrationId ||
    state.manifestSha256 !== cutover.manifestSha256
  ) {
    throw new Error('kingud_migration_destination_state_mismatch')
  }
  if (
    state.state === 'committed' &&
    (state.receipt.migrationId !== cutover.migrationId ||
      state.receipt.manifestSha256 !== cutover.manifestSha256)
  ) {
    throw new Error('kingud_migration_destination_receipt_mismatch')
  }
  const phase: KingudMigrationSourceCutoverPhase =
    state.state === 'committed' ? 'destination-committed' : 'destination-staged'
  if (phase === cutover.phase) {
    return cutover
  }
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    // Why: a journal never moves back from a proven commit.
    return cutover
  }
  const next: KingudMigrationSourceCutover = {
    ...cutover,
    phase,
    updatedAt: (context.now ?? (() => new Date()))().toISOString()
  }
  writeKingudMigrationSourceCutover(context.userDataPath, next)
  return next
}

async function abortWithRecovery(
  destination: KingudMigrationDestinationCatalog,
  manifest: KingudMigrationManifest
): Promise<KingudMigrationCatalogState> {
  try {
    return await destination.abort(manifest)
  } catch (abortError) {
    try {
      const observed = await destination.readState(manifest)
      if (observed.state === 'committed') {
        return observed
      }
      if (observed.state === 'absent') {
        // An absent read may predate the flush; a repeated abort proves it durable.
        return await destination.abort(manifest)
      }
    } catch {
      // Still unverifiable: keep the first failure and the fence.
    }
    throw abortError
  }
}

function requireCutover(userDataPath: string, migrationId: string): KingudMigrationSourceCutover {
  const cutover = listKingudMigrationSourceCutovers(userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (!cutover) {
    throw new Error('kingud_migration_source_cutover_not_found')
  }
  return cutover
}

function committedRefusal(): KingudMigrationAbortResult {
  return {
    outcome: 'refused',
    code: 'kingud_migration_committed_source_cannot_be_released',
    reason: 'The managed server already holds this migration; it can only move forward.'
  }
}

function isDestinationUnsupported(error: unknown): boolean {
  return error instanceof Error && error.message === KINGUD_MIGRATION_DESTINATION_UNSUPPORTED
}
