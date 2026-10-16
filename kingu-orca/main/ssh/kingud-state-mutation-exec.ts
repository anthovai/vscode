/**
 * Running a snapshot capture, restore or clear on the host.
 *
 * A closed channel is not a stopped command: sshd keeps a pty-less child running, and these
 * commands print nothing until they finish. So a timeout, abort or dropped channel leaves the
 * work unconfirmed, which keeps the activation fence fresh instead of letting a second restore
 * or a launch follow. Only the command's own answer, or its exit, is a verdict.
 */
import { KINGUD_STATE_MUTATION_DEADLINE_SECONDS } from './kingud-state-snapshot'
import {
  KINGUD_STATE_MUTATION_BUSY,
  KINGUD_STATE_MUTATION_DEADLINE
} from './kingud-state-snapshot-members'
import type { KingudRemoteExecTarget } from './kingud-remote-runtime-control'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import { isKingudFenceLost, KingudFenceLostError } from './kingud-activation-fence-scope'

// Longer than the host's own deadline, so the host kills the work before the client gives up.
export const KINGUD_STATE_MUTATION_CLIENT_TIMEOUT_MS =
  (KINGUD_STATE_MUTATION_DEADLINE_SECONDS + 60) * 1000

function unconfirmed(error: Error): Error & { sshChannelCloseConfirmed: false } {
  return Object.assign(error, { sshChannelCloseConfirmed: false as const })
}

/** Never aborted: cancelling the request would only stop the client from seeing the outcome. */
export async function execKingudStateMutation(
  target: KingudRemoteExecTarget,
  command: string
): Promise<string> {
  let output: string
  try {
    output = await execCommand(target.conn, command, {
      wrapCommand: target.host.commandDialect !== 'powershell',
      timeoutMs: KINGUD_STATE_MUTATION_CLIENT_TIMEOUT_MS
    })
  } catch (error) {
    // A termination error carries this flag; an exit-status error means the command finished.
    if (error instanceof Error && 'sshChannelCloseConfirmed' in error) {
      throw unconfirmed(error)
    }
    throw isKingudFenceLost(error) ? new KingudFenceLostError() : error
  }
  const verdict = output.trim().split('\n').pop()?.trim()
  if (verdict === KINGUD_STATE_MUTATION_BUSY) {
    throw unconfirmed(
      new Error('Another snapshot capture or restore is still running on the host.')
    )
  }
  if (verdict === KINGUD_STATE_MUTATION_DEADLINE) {
    throw unconfirmed(
      new Error(
        `A snapshot capture or restore ran past ${KINGUD_STATE_MUTATION_DEADLINE_SECONDS}s and ` +
          'the host stopped it part way through.'
      )
    )
  }
  return output
}

/** A finished command that failed reads as `fallback`; an unconfirmed one propagates. */
export function execKingudStateMutationOr(
  target: KingudRemoteExecTarget,
  command: string,
  fallback = ''
): Promise<string> {
  return execKingudStateMutation(target, command).catch((error: unknown) => {
    // A lost fence is a refusal, never a failed capture to fall back from.
    if (isUnconfirmedSshCommandTermination(error) || error instanceof KingudFenceLostError) {
      throw error
    }
    return fallback
  })
}
