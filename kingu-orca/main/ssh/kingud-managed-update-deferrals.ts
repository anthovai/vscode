/** The last update each managed server deferred in this session, so status can report it. */
import type { KingudManagedDeferral } from '../../shared/kingud-managed-runtime'
import { compareAppVersions } from '../../shared/app-version'

type RecordedDeferral = KingudManagedDeferral & { deferredAt: string }

const deferrals = new Map<string, RecordedDeferral>()

export function recordManagedKingudUpdateDeferral(
  environmentId: string,
  deferral: KingudManagedDeferral,
  now = new Date()
): void {
  deferrals.set(environmentId, { ...deferral, deferredAt: now.toISOString() })
}

export function clearManagedKingudUpdateDeferral(environmentId: string): void {
  deferrals.delete(environmentId)
}

export function readManagedKingudUpdateDeferral(environmentId: string): RecordedDeferral | null {
  return deferrals.get(environmentId) ?? null
}

/**
 * The deferral, unless the host already runs its candidate or a newer release: another desktop's
 * update can land it after this one deferred, and nothing here would otherwise forget it.
 */
export function currentManagedKingudUpdateDeferral(
  environmentId: string,
  activeVersion: string | null
): RecordedDeferral | null {
  const deferral = readManagedKingudUpdateDeferral(environmentId)
  if (
    deferral &&
    activeVersion &&
    (activeVersion === deferral.candidateVersion ||
      compareAppVersions(activeVersion, deferral.candidateVersion) > 0)
  ) {
    clearManagedKingudUpdateDeferral(environmentId)
    return null
  }
  return deferral
}
