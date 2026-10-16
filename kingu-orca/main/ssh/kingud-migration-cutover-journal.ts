/**
 * The cutover journal sidecar: one durable, owner-only file per migration beside the profile.
 *
 * Why not the profile store: shipped builds rewrite kingu-data.json and the profile database with
 * schemas that drop unknown fields, so a journal kept there would vanish across a downgrade while
 * the target's `kingudFence`, which shipped builds keep, survived it. A missing journal must
 * never look like "no migration"; an unreadable one fails closed.
 */
import {
  MAX_KINGUD_MIGRATION_SOURCE_CUTOVERS,
  isRetainedKingudMigrationSourceCutover,
  parseKingudMigrationSourceCutover,
  type KingudMigrationSourceCutover
} from '../../shared/kingud-migration-source-cutover'
import {
  createMigrationJournalDirectory,
  orderMigrationJournalChain
} from '../persistence/migrating-kingud-catalog/migration-journal-directory'

export class KingudMigrationCutoverJournalUnreadableError extends Error {
  constructor(detail: string) {
    super(`The migration journal cannot be read, so the SSH host stays fenced: ${detail}`)
    this.name = 'KingudMigrationCutoverJournalUnreadableError'
  }
}

type JournalChangeListener = (userDataPath: string) => void
let journalChangeListener: JournalChangeListener | null = null

/** Persistence state that follows the journal (scrollback retention) re-syncs on every change. */
export function setKingudMigrationJournalChangeListener(
  listener: JournalChangeListener | null
): void {
  journalChangeListener = listener
}

const journals = createMigrationJournalDirectory({
  directoryName: 'kingud-migration-cutovers',
  // A manifest carries catalog rows and dormant session state, never scrollback bytes.
  maxFileBytes: 16 * 1024 * 1024,
  parse: parseKingudMigrationSourceCutover,
  unreadable: (detail) => new KingudMigrationCutoverJournalUnreadableError(detail),
  onChange: (userDataPath) => journalChangeListener?.(userDataPath)
})

export function kingudMigrationCutoverJournalDirectory(userDataPath: string): string {
  return journals.directory(userDataPath)
}

/** Every journaled cutover; throws rather than skipping a file it cannot trust. */
export function listKingudMigrationSourceCutovers(
  userDataPath: string
): KingudMigrationSourceCutover[] {
  return journals.list(userDataPath)
}

/** The target's current cutover: the head of its chain, which no later delta move supersedes. */
export function findKingudMigrationSourceCutoverForTarget(
  userDataPath: string,
  sshTargetId: string
): KingudMigrationSourceCutover | null {
  const chain = listKingudMigrationCutoverChainForTarget(userDataPath, sshTargetId)
  return chain.at(-1) ?? null
}

/** Oldest first; throws unless the target's journals form one chain of delta moves. */
export function listKingudMigrationCutoverChainForTarget(
  userDataPath: string,
  sshTargetId: string
): KingudMigrationSourceCutover[] {
  const matches = listKingudMigrationSourceCutovers(userDataPath).filter(
    (cutover) => cutover.sshTargetId === sshTargetId
  )
  return orderMigrationJournalChain(
    matches,
    (detail) => new KingudMigrationCutoverJournalUnreadableError(detail),
    `SSH target ${sshTargetId}`
  )
}

/** Durable before it returns: a fence written after this always has its journal on disk. */
export function writeKingudMigrationSourceCutover(
  userDataPath: string,
  cutover: KingudMigrationSourceCutover
): void {
  const parsed = parseKingudMigrationSourceCutover(cutover)
  const existing = listKingudMigrationSourceCutovers(userDataPath)
  // Why in flight only: a retained cutover is finished and may wait two releases for retirement.
  const inFlight = existing.filter(
    (entry) => entry.phase !== 'source-retired' && !isRetainedKingudMigrationSourceCutover(entry)
  )
  if (
    !existing.some((entry) => entry.migrationId === parsed.migrationId) &&
    inFlight.length >= MAX_KINGUD_MIGRATION_SOURCE_CUTOVERS
  ) {
    throw new Error('kingud_migration_cutover_capacity_exceeded')
  }
  journals.write(userDataPath, parsed)
}

export function removeKingudMigrationSourceCutover(
  userDataPath: string,
  migrationId: string
): void {
  journals.remove(userDataPath, migrationId)
}

/** Every journal a host's stopped or never-registered server leaves behind; they grant nothing. */
export function removeKingudMigrationJournalsForDestination(
  userDataPath: string,
  sshTargetId: string,
  environmentId: string
): void {
  for (const cutover of listKingudMigrationSourceCutovers(userDataPath)) {
    if (cutover.sshTargetId === sshTargetId && cutover.destinationEnvironmentId === environmentId) {
      removeKingudMigrationSourceCutover(userDataPath, cutover.migrationId)
    }
  }
}
