/**
 * The downgrade rule every kingud activation on a shared host applies: a build may not start over
 * state a newer Kingu's kingud may already have migrated.
 */
import { compareAppVersions } from '../../shared/app-version'
import type { KingudActivationRecord } from './kingud-activation-record'

export type KingudHostVersionRefusal = 'host-newer'

export function refuseKingudHostDowngrade(
  record: KingudActivationRecord,
  candidateVersion: string,
  appVersion: string
): KingudHostVersionRefusal | null {
  // Restarting the very build that was stopped cannot downgrade anything.
  if (record.active === null && record.previous === candidateVersion) {
    return null
  }
  // Why an unnamed version is admitted: every Stop before the field existed omits it, so refusing
  // would strand those hosts for good; only a provably newer host is refused.
  if (!record.activeAppVersion) {
    return null
  }
  return compareAppVersions(record.activeAppVersion, appVersion) > 0 ? 'host-newer' : null
}
