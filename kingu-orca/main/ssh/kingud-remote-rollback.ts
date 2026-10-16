/**
 * Going back to the previously active kingud.
 *
 * Rollback is a state operation, not a binary swap. The version dirs are immutable and both
 * are still on disk, so pointing at the old one is trivial; what is not trivial is that both
 * versions share ONE data root, outside either dir. A newer kingud migrates that root on load
 * — and Kingu's persisted state carries no schema version to migrate against, so the older
 * build cannot be shown to read the result. Rollback therefore restores the pre-activation
 * snapshot, and refuses when restoring it would orphan work (`assessKingudRollback`).
 *
 * The order is the whole safety argument: stop, rescue, restore, then start. Restoring under
 * a running kingud would replace the store beneath a process holding it open, and starting
 * before restoring would let the old build migrate the new build's state. The rescue copy of
 * the newer state, and the journal under the activation fence, make each step undoable.
 */
import { logKingudActivationOutcome } from './kingud-activation-outcome-log'
import type { KingudHostTransport } from './kingud-host-transport'
import type { KingudActivationRecord } from './kingud-activation-record'
import type { KingudTerminalCensus } from './kingud-update-plan'
import type { KingudActivationVerdict } from './kingud-activation-gate'
import type { KingudDaemonProtocolFacts } from './kingud-daemon-protocol-crossing'
import { readKingudActivationRecord } from './kingud-activation-record-store'
import { sameKingudActivationRecord } from './kingud-activation-transaction'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import {
  resolveKingudActivationReadinessTimeout,
  withKingudActivationLock
} from './kingud-activation-lock'
import { kingudActivationFenceRefusal } from './kingud-activation-fence-hold'
import { KINGUD_STARTUP_READINESS_TIMEOUT_MS } from '../../shared/kingud-profile-preflight'
import { rollbackKingudLocked } from './kingud-rollback-transition'

export type KingudRollbackOptions = {
  conn: KingudHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  record: KingudActivationRecord
  nodePath: string
  userDataDir: string
  bindHost: string
  port: number
  census: KingudTerminalCensus
  /** Expected build hash of the rollback target, from the client's copy of those bytes. */
  targetBuildHash: string
  /** The rollback target's daemon protocol facts, from the same copy. */
  targetDaemonProtocol: KingudDaemonProtocolFacts
  readinessTimeoutMs?: number
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

export type KingudRollbackResult =
  | {
      outcome: 'rolled-back'
      target: string
      discarded: string[]
      verdict: KingudActivationVerdict
    }
  | { outcome: 'refused'; code: string; reason: string }
  | { outcome: 'failed'; code: string; reason: string }

export async function rollbackKingud(input: KingudRollbackOptions): Promise<KingudRollbackResult> {
  const options = {
    ...input,
    readinessTimeoutMs: resolveKingudActivationReadinessTimeout(
      input.readinessTimeoutMs,
      KINGUD_STARTUP_READINESS_TIMEOUT_MS
    )
  }
  return logKingudActivationOutcome(
    `rollback to ${options.record.previous ?? 'none'}`,
    () =>
      withKingudActivationLock(
        options,
        async (lock) => {
          if (
            !sameKingudActivationRecord(await readKingudActivationRecord(options), options.record)
          ) {
            return {
              outcome: 'refused',
              code: 'kingud_rollback_record_changed',
              reason:
                'The host activation record changed while this rollback was waiting. Refresh the ' +
                'host state and review the new rollback target before trying again.'
            }
          }
          return rollbackKingudLocked(options, lock)
        },
        async () => {
          const { code, reason } = await kingudActivationFenceRefusal(options, 'rollback')
          return { outcome: 'refused', code, reason }
        }
      ),
    ['rolled-back']
  )
}
