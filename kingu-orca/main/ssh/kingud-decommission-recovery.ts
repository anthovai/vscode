/** Recovering an interrupted decommission from its journal entry; see kingud-decommission-transaction. */
import { writeKingudActivationRecord } from './kingud-activation-record-store'
import type { KingudActivationRecoveryResult } from './kingud-activation-recovery'
import type { KingudDecommissionRecoveryPlan } from './kingud-decommission-transaction'
import { settleKingudDecommissionStop } from './kingud-decommission-stop'
import { kingudLivenessProbeCommand, parseKingudLiveness } from './kingud-remote-launch'
import { execKingudRemote } from './kingud-remote-runtime-control'
import {
  ensureKingudSlotServing,
  kingudSlotDir,
  resolveKingudSlotIdentity,
  type KingudSlotOptions
} from './kingud-recovery-slot'

export async function reconcileKingudDecommission(
  options: KingudSlotOptions,
  plan: KingudDecommissionRecoveryPlan
): Promise<KingudActivationRecoveryResult> {
  if (plan.action === 'keep-serving') {
    // Nothing was sent, so the recorded version must still be the one serving.
    const identity = await resolveKingudSlotIdentity(options, plan.version)
    return {
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: plan.version,
      readiness: await ensureKingudSlotServing(options, identity)
    }
  }
  if (plan.action === 'resume-stop') {
    const settlement = await settleKingudDecommissionStop(options, plan.request)
    if (settlement.state === 'unsettled') {
      return {
        outcome: 'refused',
        verdict: settlement.verdict,
        code: 'kingud_recovery_decommission_unsettled',
        reason: settlement.reason
      }
    }
    if (settlement.state === 'withdrawn') {
      return reconcileKingudDecommission(options, {
        action: 'keep-serving',
        version: plan.request.version
      })
    }
    return reconcileKingudDecommission(options, {
      action: 'confirm-decommissioned',
      version: plan.request.version,
      record: plan.record
    })
  }
  // Only proven exit commits; a slot that is live or unanswering keeps the fence.
  const liveness = parseKingudLiveness(
    await execKingudRemote(
      options,
      kingudLivenessProbeCommand(options.host, kingudSlotDir(options, plan.version))
    )
  )
  if (liveness !== 'DEAD') {
    return {
      outcome: 'refused',
      verdict: liveness === 'LIVE' ? 'live' : 'unverifiable',
      code: 'kingud_recovery_decommissioned_slot_not_exited',
      reason: `kingud ${plan.version} is recorded as stopped but is ${liveness.toLowerCase()}.`
    }
  }
  if (plan.record) {
    await writeKingudActivationRecord(options, plan.record)
  }
  return { outcome: 'recovered', resolution: 'committed', activeVersion: null, readiness: null }
}
