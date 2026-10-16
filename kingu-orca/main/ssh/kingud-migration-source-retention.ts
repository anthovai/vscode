/**
 * After commit: a migration keeps its source rows, so a downgraded build still sees the host and
 * its projects and can reach them over its own relay. New builds hide those rows and serve the host
 * from the server. They are never deleted automatically.
 */
import type { KingudMigrationSourceCutover } from '../../shared/kingud-migration-source-cutover'
import {
  listKingudMigrationSourceCutovers,
  writeKingudMigrationSourceCutover
} from './kingud-migration-cutover-journal'

/** Marks a committed migration as finished for this build while its source rows stay. */
export function retainKingudMigrationSource(
  userDataPath: string,
  migrationId: string,
  now: () => Date = () => new Date()
): KingudMigrationSourceCutover {
  const cutover = listKingudMigrationSourceCutovers(userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (!cutover || cutover.phase !== 'destination-committed') {
    throw new Error('kingud_migration_retain_before_commit')
  }
  if (cutover.sourceRetainedAt) {
    return cutover
  }
  // Why no baseline here: the source may have changed since the commit (a crash, then an older
  // build); only the fence's pre-commit baseline proves what the server holds.
  const retained = { ...cutover, sourceRetainedAt: now().toISOString() }
  writeKingudMigrationSourceCutover(userDataPath, retained)
  return retained
}
