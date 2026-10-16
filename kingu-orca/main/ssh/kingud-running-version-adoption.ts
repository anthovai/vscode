/**
 * A first deploy onto a host whose kingud another Kingu version already runs. Its terminal count
 * needs a paired connection, so the update would always wait; instead this client pairs with the
 * running build as it is, and the linked update check decides whether it may replace it.
 */
import type { ServeReadiness } from '../server/serve-readiness'
import type { KingudManagedDeferral } from '../../shared/kingud-managed-runtime'
import { kingudActivationFenceRefusal } from './kingud-activation-fence-hold'
import { KingudActiveReadinessError, probeActiveKingudReadiness } from './kingud-active-readiness'
import type { KingudActivationRecord } from './kingud-activation-record'
import { readKingudActivationRecord } from './kingud-activation-record-store'
import { wakeStoppedManagedKingud } from './kingud-managed-wake'
import { resolveKingudSlotIdentity, type KingudSlotOptions } from './kingud-recovery-slot'

export type KingudRunningAdoption = {
  version: string
  readiness: ServeReadiness
  /** Reads the adopted slot's readiness again, e.g. after it rebinds its port. */
  reprobe: () => Promise<ServeReadiness>
}

/**
 * Null when no other version is activated, so the caller deploys its own as usual. A deferral
 * when another run holds the host's fence: its own deploy could never count terminals over that
 * version, so it would only defer on the census once the fence cleared (#28833).
 */
export async function adoptRunningKingudVersion(
  slot: KingudSlotOptions,
  record: KingudActivationRecord,
  localVersion: string,
  retryClearedFence = true
): Promise<KingudRunningAdoption | KingudManagedDeferral | null> {
  if (!record.active || record.active === localVersion) {
    return null
  }
  // Starts it only on proven exit: an idle stop leaves its daemon's terminals running.
  const wake = await wakeStoppedManagedKingud(slot)
  switch (wake.outcome) {
    // Another desktop stopped it meanwhile; the deploy's own gates decide.
    case 'not-activated':
      return null
    case 'fenced': {
      // E.g. another desktop starting it after a reboot; a later connect pairs with it.
      const { cleared, ...refusal } = await kingudActivationFenceRefusal(slot, 'server start')
      if (cleared && retryClearedFence) {
        return adoptRunningKingudVersion(slot, record, localVersion, false)
      }
      return { outcome: 'deferred', candidateVersion: localVersion, ...refusal, forceable: false }
    }
    case 'unverifiable':
      throw new KingudActiveReadinessError(
        'unverifiable',
        `Kingu ${record.active} runs this host's server, but its process state is unverifiable, ` +
          'so it was left as it is. Try connecting again.'
      )
    case 'recovery-refused':
      throw new Error(wake.reason)
    case 'serving':
    case 'started':
      break
  }
  // Re-read: the wake follows whatever the record names now, which another desktop may change.
  const active = (await readKingudActivationRecord(slot)).active
  if (!active || active === localVersion) {
    return null
  }
  const identity = await resolveKingudSlotIdentity(slot, active)
  const reprobe = () =>
    probeActiveKingudReadiness(
      { ...slot, remoteInstallDir: identity.remoteDir },
      { buildHash: identity.buildHash, fullVersion: identity.version }
    )
  return { version: active, readiness: await reprobe(), reprobe }
}
