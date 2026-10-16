/**
 * Converting a relay-hosted SSH target that holds Kingu state into a managed kingud server:
 * fence the source, deploy and pair the server, stage and commit the dormant catalog, then keep
 * the source rows, hidden, for a downgraded build.
 *
 * Every step is keyed by the journal, so calling this again after a crash or lost contact resumes
 * the same migration instead of starting another. The source stays authoritative until the
 * destination proves its commit, and is never deleted afterwards.
 */
import { randomUUID } from 'node:crypto'
import type { KingudManagedConversionResult } from '../../shared/kingud-managed-runtime'
import type { KingudMigrationSourceCutover } from '../../shared/kingud-migration-source-cutover'
import { recordManagedKingudMigration } from '../../shared/runtime-environment-managed-kingud-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  getKingudSshDeployment,
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import { environmentMatchesManagedKingudCutover } from './kingud-managed-migration-status'
import { requireManagedKingudInfrastructure } from './kingud-managed-runtime-context'
import { ensureKingudManagedTunnel } from './kingud-managed-tunnel'
import {
  commitKingudMigrationDestination,
  type KingudMigrationDestinationCatalog
} from './kingud-migration-cutover-coordinator'
import {
  findKingudMigrationSourceCutoverForTarget,
  removeKingudMigrationJournalsForDestination
} from './kingud-migration-cutover-journal'
import type { SshTarget } from '../../shared/ssh-types'
import type { CensusHostRelayTerminals } from './kingud-migration-terminal-gate'
import { createManagedKingudEnvironment } from './kingud-runtime-deployment'
import { createSshRelayMigrationSource } from './kingud-migration-ssh-relay-source'
import {
  leaveBehindClearsKingudMigrationBlockers,
  onlyLeavableKingudMigrationBlockers
} from './ssh-target-kingud-preflight'
import { KINGUD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON } from './kingud-migration-source-fence'
import { retainKingudMigrationSource } from './kingud-migration-source-retention'
import {
  linkedKingudMigrationCutoverPort,
  linkedKingudMigrationProjects,
  linkServerHeldRepositories,
  type KingudServerRepository
} from './kingud-migration-repository-link'

export type KingudManagedConversionArgs = {
  sshTargetId: string
  name: string
  /** The census of the host's relay endpoints that must prove exit. */
  censusHost?: ((target: SshTarget) => ReturnType<CensusHostRelayTerminals>) | null
  /** The destination's T6-9 catalog client, reached through the server's tunnel. */
  destinationFor: (environment: KnownRuntimeEnvironment) => KingudMigrationDestinationCatalog
  /** The server's own projects, so ones this host already holds at the same path link to them. */
  serverRepositoriesFor?: (
    environment: KnownRuntimeEnvironment
  ) => Promise<KingudServerRepository[]>
  /** Releases the direct SSH session after the terminal check, before the fence. */
  releaseDirectSession?: (sshTargetId: string) => Promise<void>
  now?: () => Date
  signal?: AbortSignal
}

export async function convertSshTargetToManagedKingud(
  userDataPath: string,
  args: KingudManagedConversionArgs
): Promise<KingudManagedConversionResult> {
  const fenced = await fenceOrResume(userDataPath, args)
  if ('outcome' in fenced) {
    return fenced
  }
  const deployed = await createManagedKingudEnvironment(userDataPath, {
    name: fenced.destinationName,
    sshTargetId: fenced.sshTargetId,
    migration: true,
    signal: args.signal
  })
  if (deployed.outcome === 'deferred') {
    return deployed // The fence and journal stay; a later call resumes here.
  }
  const environment = listEnvironments(userDataPath).find(
    (entry) => entry.id === fenced.destinationEnvironmentId
  )
  if (!environment || !environmentMatchesManagedKingudCutover(environment, fenced)) {
    throw new Error('kingud_migration_destination_environment_mismatch')
  }
  // Before any commit can land, so a crash after it still blocks rollbacks across it.
  const marked = recordManagedKingudMigration(
    userDataPath,
    environment.id,
    (args.now ?? (() => new Date()))().toISOString()
  )
  await ensureKingudManagedTunnel(userDataPath, environment.id)
  const { claims, targetStore } = requireManagedKingudInfrastructure()
  const store = targetStore.getKingudMigrationSource()
  const destination = args.destinationFor(marked)
  const serverRepositoriesFor = args.serverRepositoriesFor
  let linkedRepositoryIds: string[] | undefined
  const committed = await runTargetLifecycle(fenced.sshTargetId, async () => {
    const journaled = requireJournaledCutover(userDataPath, fenced)
    const cutover = serverRepositoriesFor
      ? await linkServerHeldRepositories({
          userDataPath,
          store,
          claims,
          cutover: journaled,
          destination,
          serverRepositories: () => serverRepositoriesFor(marked),
          now: args.now
        })
      : journaled
    linkedRepositoryIds = cutover.linkedRepositoryIds
    return commitKingudMigrationDestination(
      {
        userDataPath,
        store,
        claims,
        source: linkedKingudMigrationCutoverPort({ userDataPath, store, claims, cutover }),
        destination,
        now: args.now
      },
      cutover.migrationId
    )
  })
  if (committed.phase !== 'destination-committed' && committed.phase !== 'source-retired') {
    throw new Error(`kingud_migration_commit_not_proven:${committed.phase}`)
  }
  if (committed.phase === 'destination-committed') {
    retainKingudMigrationSource(userDataPath, committed.migrationId, args.now)
  }
  const linkedProjects = linkedKingudMigrationProjects(store, { linkedRepositoryIds })
  return {
    outcome: 'converted',
    environment: redactRuntimeEnvironment(marked),
    migrationId: committed.migrationId,
    ...(linkedProjects.length > 0 ? { linkedProjects } : {})
  }
}

async function fenceOrResume(
  userDataPath: string,
  args: KingudManagedConversionArgs
): Promise<
  KingudMigrationSourceCutover | Extract<KingudManagedConversionResult, { outcome: 'refused' }>
> {
  const { claims, targetStore } = requireManagedKingudInfrastructure()
  const target = targetStore.getTarget(args.sshTargetId)
  if (!target) {
    return refuse('unverifiable', 'kingud_migration_target_not_found', 'The SSH host is gone.')
  }
  const store = targetStore.getKingudMigrationSource()
  const censusHost = args.censusHost
  const source = createSshRelayMigrationSource({
    userDataPath,
    store,
    claims,
    target,
    censusHost: censusHost ? () => censusHost(target) : null
  })
  const existing = source.resolveFence()
  if (existing.state === 'fenced') {
    return existing.cutover
  }
  const stale = existing.state === 'stale-journal' ? existing.cutover : null
  if (stale && !isRegistered(userDataPath, stale.destinationEnvironmentId)) {
    // Its fence is gone and its server unregistered, so nothing it records can still be acted on.
    removeKingudMigrationJournalsForDestination(
      userDataPath,
      target.id,
      stale.destinationEnvironmentId
    )
  }
  const converted = listEnvironments(userDataPath).some(
    (environment) => getKingudSshDeployment(environment)?.sshTargetId === target.id
  )
  if (converted) {
    return refuse(
      'live',
      'kingud_migration_already_managed',
      'This SSH host is already a managed server.'
    )
  }
  // The fence re-checks leases once it holds.
  const terminalProof = await source.assessTerminals()
  if (terminalProof.verdict === 'live' || terminalProof.verdict === 'unverifiable') {
    return refuse(terminalProof.verdict, 'kingud_migration_terminals', terminalProof.reason)
  }
  source.retireProvenExitedTerminals(terminalProof)
  await args.releaseDirectSession?.(target.id)
  const result = await runTargetLifecycle(target.id, () =>
    source.acquireFence({
      destinationEnvironmentId: randomUUID(),
      destinationName: args.name,
      terminalProof,
      now: args.now,
      signal: args.signal
    })
  )
  if (result.outcome === 'fenced') {
    return result.cutover
  }
  if (result.blockers?.length) {
    // Why logged: the connect surfaces only the reason, and support needs which state blocked.
    console.warn(
      '[ssh] Conversion refused by:',
      JSON.stringify(
        result.blockers.map((blocker) =>
          'dependencies' in blocker
            ? { code: blocker.code, dependencies: blocker.dependencies }
            : { code: blocker.code }
        )
      )
    )
  }
  // Already moving anyway: what still refuses is what can't be left behind.
  const leavable =
    result.blockers &&
    onlyLeavableKingudMigrationBlockers(result.blockers) &&
    !target.managedServerLeaveBehind
  if (leavable && terminalProof.verdict !== 'exited') {
    // Why no offer: leaving tabs behind would strand terminals the relay bridge still serves.
    return refuse(
      result.verdict,
      result.code,
      `${result.reason} ${KINGUD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON}`
    )
  }
  return {
    ...refuse(result.verdict, result.code, result.reason),
    // Why previewed: an offer the confirmed export would refuse again is a dead end.
    ...(leavable && leaveBehindClearsKingudMigrationBlockers(store, target.id)
      ? { canLeaveBehind: true }
      : {})
  }
}

function requireJournaledCutover(
  userDataPath: string,
  fenced: KingudMigrationSourceCutover
): KingudMigrationSourceCutover {
  const journaled = findKingudMigrationSourceCutoverForTarget(userDataPath, fenced.sshTargetId)
  if (journaled?.migrationId !== fenced.migrationId) {
    throw new Error('kingud_migration_source_fence_lost')
  }
  return journaled
}

function isRegistered(userDataPath: string, environmentId: string): boolean {
  return listEnvironments(userDataPath).some((environment) => environment.id === environmentId)
}

function refuse(
  verdict: 'live' | 'unverifiable',
  code: string,
  reason: string
): Extract<KingudManagedConversionResult, { outcome: 'refused' }> {
  return { outcome: 'refused', verdict, code, reason }
}
