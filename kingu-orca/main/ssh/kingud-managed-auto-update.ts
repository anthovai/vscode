/**
 * Updating a managed kingud on connect, through the same update the Managed servers action runs.
 *
 * The connect only picks whether to try: the update planner still defers over live or uncounted
 * terminals, and a rejected candidate is restored through the activation journal, so the old
 * version keeps serving. A host a newer Kingu activated is never downgraded.
 */
import type { KingudActivationRecord } from './kingud-activation-record'
import {
  refuseKingudHostDowngrade,
  type KingudHostVersionRefusal
} from './kingud-host-version-admission'
import { materializeKingudArtifact } from '../kingud/kingud-artifact-materializer'
import {
  KingudArtifactsUnavailableError,
  KingudHostUnsupportedError
} from '../kingud/kingud-host-unavailable'
import { findIncompleteManagedKingudMigration } from './kingud-managed-migration-status'
import { KINGUD_ACTIVATION_FENCE_BUSY_CODE } from './kingud-activation-fence-hold'
import { resolveLinkedKingudContext } from './kingud-managed-runtime-context'
import { runManagedKingudUpdate, withManagedKingudLifecycle } from './kingud-runtime-maintenance'
import type { KingudUpdateDeferCode } from './kingud-update-plan'
import { readLocalFullVersion } from './remote-versioned-install'

export type ManagedKingudAutoUpdateSkip =
  | 'current'
  | 'no-template'
  | 'rolled-back'
  | 'failed-before'
  | 'migrating'
  | KingudHostVersionRefusal

export type ManagedKingudAutoUpdatePlan =
  | { action: 'update' }
  | { action: 'skip'; reason: ManagedKingudAutoUpdateSkip }

export type ManagedKingudAutoUpdateOutcome =
  | { outcome: 'skipped'; reason: ManagedKingudAutoUpdateSkip }
  | { outcome: 'updated'; activeVersion: string }
  /** The update planner chose to wait, e.g. for terminals to close; a later connect retries. */
  | { outcome: 'deferred'; code: string; reason: string }
  /** The candidate was rejected or the update threw; the incumbent keeps serving. */
  | { outcome: 'failed'; reason: string }

export function planManagedKingudAutoUpdate(input: {
  record: KingudActivationRecord
  /** This app's bundled build for the host's target; null when the template lacks it. */
  candidateVersion: string | null
  appVersion: string
  /** An update to this app version already failed on this host. */
  failedBefore: boolean
}): ManagedKingudAutoUpdatePlan {
  const { record, candidateVersion } = input
  if (!candidateVersion) {
    return { action: 'skip', reason: 'no-template' }
  }
  if (record.active === candidateVersion) {
    return { action: 'skip', reason: 'current' }
  }
  if (record.rolledBackFrom === candidateVersion) {
    return { action: 'skip', reason: 'rolled-back' }
  }
  const refusal = refuseKingudHostDowngrade(record, candidateVersion, input.appVersion)
  if (refusal) {
    return { action: 'skip', reason: refusal }
  }
  // Why no `failedBefore` skip on a stopped host: nothing serves, so retrying is the only way back.
  if (record.active === null && record.previous !== null) {
    return { action: 'update' }
  }
  return input.failedBefore ? { action: 'skip', reason: 'failed-before' } : { action: 'update' }
}

const WAITING_CODES: ReadonlySet<string> = new Set<
  KingudUpdateDeferCode | typeof KINGUD_ACTIVATION_FENCE_BUSY_CODE
>([
  KINGUD_ACTIVATION_FENCE_BUSY_CODE,
  'kingud_update_terminals_running',
  'kingud_update_terminal_census_unavailable',
  'kingud_update_strands_live_terminals',
  'kingud_update_daemon_protocol_unverifiable',
  'kingud_update_ends_in_process_terminals'
])

/**
 * Deferrals that mean "not now", as opposed to a candidate that was tried and rejected. An
 * interrupted activation is not one: no later connect clears it, so it surfaces as a failure.
 */
export function isWaitingKingudUpdateDeferral(code: string): boolean {
  return WAITING_CODES.has(code)
}

export function autoUpdateManagedKingudEnvironment(
  userDataPath: string,
  args: {
    environmentId: string
    appVersion: string
    failedBefore: boolean
    onUpdating: () => void
  }
): Promise<ManagedKingudAutoUpdateOutcome> {
  return withManagedKingudLifecycle(userDataPath, args.environmentId, async (managed) => {
    // Why: a restart mid-migration would race the staging the cutover journal is driving.
    if (findIncompleteManagedKingudMigration(userDataPath, managed.environment.id)) {
      return { outcome: 'skipped', reason: 'migrating' }
    }
    const context = await resolveLinkedKingudContext(managed.environment, managed.deployment)
    const candidateVersion = await bundledKingudVersion(context.serverTarget)
    const plan = planManagedKingudAutoUpdate({
      record: context.activationRecord,
      candidateVersion,
      appVersion: args.appVersion,
      failedBefore: args.failedBefore
    })
    if (plan.action === 'skip') {
      return { outcome: 'skipped', reason: plan.reason }
    }
    args.onUpdating()
    let lockedSkip: ManagedKingudAutoUpdateSkip | null = null
    try {
      const result = await runManagedKingudUpdate(userDataPath, managed, context, {
        // Why again under the fence: another desktop may activate or stop a newer build mid-upload.
        admitRecord: (record) => {
          const locked = planManagedKingudAutoUpdate({
            record,
            candidateVersion,
            appVersion: args.appVersion,
            failedBefore: false
          })
          if (locked.action === 'update') {
            return null
          }
          lockedSkip = locked.reason
          return `Auto-update skipped under the host fence: ${locked.reason}.`
        }
      })
      if (lockedSkip) {
        return { outcome: 'skipped', reason: lockedSkip }
      }
      if (result.outcome !== 'deferred') {
        return { outcome: 'updated', activeVersion: result.activeVersion }
      }
      return isWaitingKingudUpdateDeferral(result.code)
        ? { outcome: 'deferred', code: result.code, reason: result.reason }
        : { outcome: 'failed', reason: result.reason }
    } catch (error) {
      return { outcome: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
  })
}

type KingudTarget = Parameters<typeof materializeKingudArtifact>[0]

// Why per session: the packaged template can't change while the app runs, and hashing it costs a read.
const bundledVersions = new Map<KingudTarget, Promise<string | null>>()

function bundledKingudVersion(target: KingudTarget): Promise<string | null> {
  let version = bundledVersions.get(target)
  if (!version) {
    version = materializeKingudArtifact(target).then(readLocalFullVersion, (error: unknown) => {
      if (
        error instanceof KingudHostUnsupportedError ||
        error instanceof KingudArtifactsUnavailableError
      ) {
        return null
      }
      throw error
    })
    // A transient local failure must not stick for the session.
    version.catch(() => bundledVersions.delete(target))
    bundledVersions.set(target, version)
  }
  return version
}

export function resetBundledKingudVersionsForTests(): void {
  bundledVersions.clear()
}
