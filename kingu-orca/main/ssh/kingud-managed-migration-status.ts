/** Which dormant migrations into managed servers have not finished, for status and resume. */
import {
  isRetainedKingudMigrationSourceCutover,
  type KingudMigrationSourceCutover
} from '../../shared/kingud-migration-source-cutover'
import {
  getKingudSshDeployment,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { listKingudMigrationSourceCutovers } from './kingud-migration-cutover-journal'

export type KingudManagedPendingMigration = {
  migrationId: string
  environmentId: string
  name: string
  sshTargetId: string
  phase: KingudMigrationSourceCutover['phase']
  startedAt: string
}

/** Throws on an unreadable journal: a migration we cannot read is not "none". */
export function listPendingManagedKingudMigrations(
  userDataPath: string
): KingudManagedPendingMigration[] {
  return (
    listKingudMigrationSourceCutovers(userDataPath)
      // Why retained too: committed is finished; keeping source rows is downgrade insurance, not work.
      .filter(
        (cutover) =>
          cutover.phase !== 'source-retired' && !isRetainedKingudMigrationSourceCutover(cutover)
      )
      .map((cutover) => ({
        migrationId: cutover.migrationId,
        environmentId: cutover.destinationEnvironmentId,
        name: cutover.destinationName,
        sshTargetId: cutover.sshTargetId,
        phase: cutover.phase,
        startedAt: cutover.startedAt
      }))
  )
}

export function findIncompleteManagedKingudMigration(
  userDataPath: string,
  environmentId: string
): KingudManagedPendingMigration | null {
  return (
    listPendingManagedKingudMigrations(userDataPath).find(
      (migration) => migration.environmentId === environmentId
    ) ?? null
  )
}

/** The registered server is the one the journal deploys into, on the journaled registration. */
export function environmentMatchesManagedKingudCutover(
  environment: KnownRuntimeEnvironment,
  cutover: KingudMigrationSourceCutover
): boolean {
  const deployment = getKingudSshDeployment(environment)
  return (
    environment.id === cutover.destinationEnvironmentId &&
    environment.name === cutover.destinationName &&
    deployment?.sshTargetId === cutover.sshTargetId &&
    deployment.sshTargetGeneration === cutover.sshTargetGeneration
  )
}
