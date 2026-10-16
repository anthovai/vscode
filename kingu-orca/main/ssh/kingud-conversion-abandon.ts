/**
 * Gives a host whose conversion stopped short back to the relay. A destination that was never
 * registered held nothing; a registered one must prove through an abort that it holds nothing,
 * and is unregistered before the fence goes so no later start re-fences the host to it.
 */
import { removeManagedKingudEnvironment } from '../../shared/runtime-environment-managed-kingud-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { closeKingudManagedTunnel } from './kingud-managed-tunnel'
import {
  abortKingudMigrationCutover,
  type KingudMigrationAbortResult,
  type KingudMigrationCutoverContext,
  type KingudMigrationDestinationCatalog
} from './kingud-migration-cutover-coordinator'
import { findKingudMigrationSourceCutoverForTarget } from './kingud-migration-cutover-journal'
import {
  releaseKingudMigrationFence,
  releaseUndeployedMigrationFence
} from './kingud-migration-source-fence'

export async function abandonKingudConversion(args: {
  userDataPath: string
  store: KingudMigrationCutoverContext['store']
  claims: KingudMigrationCutoverContext['claims']
  targetId: string
  destinationFor: (environment: KnownRuntimeEnvironment) => KingudMigrationDestinationCatalog
}): Promise<KingudMigrationAbortResult | 'none'> {
  const cutover = findKingudMigrationSourceCutoverForTarget(args.userDataPath, args.targetId)
  // A delta move keeps its committed chain; it resolves through the delta flow, never here.
  if (!cutover || cutover.supersedesMigrationId) {
    return 'none'
  }
  const isRegistered = (id: string): boolean =>
    listEnvironments(args.userDataPath).some((entry) => entry.id === id)
  const environment = listEnvironments(args.userDataPath).find(
    (entry) => entry.id === cutover.destinationEnvironmentId
  )
  if (!environment) {
    await releaseUndeployedMigrationFence({ ...args, isDestinationRegistered: isRegistered })
    return 'none'
  }
  const context = { ...args, destination: args.destinationFor(environment) }
  return abortKingudMigrationCutover(context, cutover.migrationId, async (aborted) => {
    await closeKingudManagedTunnel(environment.id).catch(() => undefined)
    removeManagedKingudEnvironment(args.userDataPath, environment.id)
    await releaseKingudMigrationFence(context, aborted)
  })
}
