/**
 * One activation or rollback per host, and the fence an interrupted one leaves behind.
 *
 * The lock lives in the transaction root, so releasing it also removes the journal. A run
 * that cannot prove the host is back to one serving slot retains both and marks the lock
 * ownerless; only recovery may take a retained fence over, and it waits out the install lock's
 * stale window only for a fence whose holder may still be working.
 */
import { randomUUID } from 'node:crypto'
import {
  execKingudRemote,
  withoutAbortSignal,
  type KingudRemoteExecTarget
} from './kingud-remote-runtime-control'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import { acquireInstallLock, RemoteInstallLockBusyError } from './ssh-relay-install-lock'
import {
  orphanInstallLockCommand,
  probeInstallLockExistsCommand
} from './ssh-relay-install-lock-commands'
import { shellEscape } from './ssh-connection-utils'
import {
  KINGUD_FENCE_OWNER_FILENAME,
  posixKingudFenceOwnedTest,
  runWithKingudFence,
  type KingudFence
} from './kingud-activation-fence-scope'
import { kingudRemoteBaseDir, kingudWindowsHomeOpCommand } from './kingud-remote-windows-node'
import { forgetHeldKingudFence, rememberHeldKingudFence } from './kingud-held-fence-tokens'
import { exitedOwnLockProof } from './kingud-exited-own-lock'
import { isWindowsRemoteHost } from './ssh-remote-platform'
import {
  kingudActivationFenceLockDir,
  kingudActivationTransactionPath,
  kingudActivationTransactionRoot
} from './kingud-activation-transaction'
import {
  readKingudActivationTransaction,
  writeKingudActivationTransaction
} from './kingud-activation-transaction-store'

const KINGUD_ACTIVATION_MAX_READINESS_TIMEOUT_MS = 5 * 60_000

export type KingudActivationLockOptions = KingudRemoteExecTarget & { remoteHome: string }

export type KingudActivationLockControl = {
  /** Keep the fence if the run throws: a journal now describes host state. */
  retainOnError(): void
  /** Keep the fence even on return: the host is not proven back to one serving slot. */
  retain(): void
  /** The host is proven back on its recorded slot: release even if the run then throws. */
  recovered(): void
}

/** Bounded so a crashed holder's lock goes stale long before a live holder could still be waiting. */
export function resolveKingudActivationReadinessTimeout(
  configured: number | undefined,
  fallback: number
): number {
  const timeout = configured ?? fallback
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > KINGUD_ACTIVATION_MAX_READINESS_TIMEOUT_MS
  ) {
    throw new Error(
      `kingud readiness timeout must be an integer from 1 to ${KINGUD_ACTIVATION_MAX_READINESS_TIMEOUT_MS}ms`
    )
  }
  return timeout
}

// Long enough for a brief hold (a wake, a retried lock command), short beside a lifecycle queue.
const KINGUD_ACTIVATION_FENCE_WAIT_MS = 5_000

/**
 * A fence still held after a short wait answers `held()`: a retained one never clears by waiting.
 * `token` names this run's generation; a wake passes its own so it can prove an interrupted fence.
 */
export async function withKingudActivationLock<T>(
  options: KingudActivationLockOptions,
  run: (control: KingudActivationLockControl) => Promise<T>,
  held: () => T | Promise<T>,
  token: string = randomUUID()
): Promise<T> {
  const lockRoot = kingudActivationTransactionRoot(options.host, options.remoteHome)
  rememberHeldKingudFence(token)
  try {
    await acquireInstallLock(options.conn, lockRoot, options.host, {
      signal: options.signal,
      relayGcClaim: false,
      // A retained fence means state ownership is unresolved. Age cannot make it safe.
      allowStaleTakeover: false,
      waitTimeoutMs: KINGUD_ACTIVATION_FENCE_WAIT_MS,
      owner: { fileName: KINGUD_FENCE_OWNER_FILENAME, token }
    })
  } catch (error) {
    if (error instanceof RemoteInstallLockBusyError) {
      forgetHeldKingudFence(token)
      return await held()
    }
    throw error
  }
  const fence = activationFence(options, token)
  let retainOnError = false
  let retain = false
  try {
    const result = await runWithKingudFence(fence, () =>
      run({
        retainOnError: () => {
          retainOnError = true
        },
        retain: () => {
          retain = true
        },
        recovered: () => {
          retainOnError = false
        }
      })
    )
    await (retain ? orphanRetainedFence(options, fence) : releaseActivationFence(options, fence))
    return result
  } catch (error) {
    // A remote mutation whose teardown is unconfirmed may still be running: keep its fence fresh.
    if (!isUnconfirmedSshCommandTermination(error)) {
      await (
        retainOnError ? orphanRetainedFence(options, fence) : releaseActivationFence(options, fence)
      ).catch((releaseError: unknown) => {
        console.warn(
          `[kingud] Failed to release activation lock after an error: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`
        )
      })
    }
    throw error
  }
}

/**
 * Takes over only a stale or previous-boot fence, or one this desktop's exited process left;
 * a fresh one throws `RemoteInstallLockBusyError`.
 */
export async function withStaleKingudActivationRecoveryLock<T>(
  options: KingudActivationLockOptions,
  run: (control: Pick<KingudActivationLockControl, 'retain'>) => Promise<T>
): Promise<T> {
  const lockRoot = kingudActivationTransactionRoot(options.host, options.remoteHome)
  const token = randomUUID()
  rememberHeldKingudFence(token)
  // The takeover writes this run's token, so the holder it replaced can no longer act or release.
  await acquireInstallLock(options.conn, lockRoot, options.host, {
    signal: options.signal,
    relayGcClaim: false,
    allowStaleTakeover: true,
    waitTimeoutMs: 0,
    owner: { fileName: KINGUD_FENCE_OWNER_FILENAME, token },
    exitedOwner: exitedOwnLockProof(options, {
      baseDir: kingudRemoteBaseDir(options.host, options.remoteHome),
      guardsStateMutation: true
    })
  }).catch((error: unknown) => {
    if (error instanceof RemoteInstallLockBusyError) {
      forgetHeldKingudFence(token)
    }
    throw error
  })
  const fence = activationFence(options, token)
  let retain = false
  let result: T
  try {
    result = await runWithKingudFence(fence, async () => {
      await adoptInterruptedJournal(options)
      return run({ retain: () => (retain = true) })
    })
  } catch (error) {
    // Any throw keeps the fence: recovery failed to prove one serving slot.
    if (!isUnconfirmedSshCommandTermination(error)) {
      await orphanRetainedFence(options, fence).catch(() => undefined)
    }
    throw error
  }
  await (retain ? orphanRetainedFence(options, fence) : releaseActivationFence(options, fence))
  return result
}

/** Re-stamps a taken-over run's journal with this generation, so this run's release removes it. */
async function adoptInterruptedJournal(options: KingudActivationLockOptions): Promise<void> {
  const journal = await readKingudActivationTransaction(options).catch(() => null)
  if (journal) {
    await writeKingudActivationTransaction(options, journal)
  }
}

function activationFence(options: KingudActivationLockOptions, token: string): KingudFence {
  return { lockDir: kingudActivationFenceLockDir(options.host, options.remoteHome), token }
}

/**
 * A fence this run keeps after it is done: nothing of ours still works under it, so the next
 * recovery may take it over at once. Left fresh, every failed recovery would restart the stale
 * window it waits out, and the host could never be recovered. Guarded, so a superseded run
 * never ages its successor's fence.
 */
async function orphanRetainedFence(
  options: KingudActivationLockOptions,
  fence: KingudFence
): Promise<void> {
  try {
    await runWithKingudFence(fence, () =>
      execKingudRemote(
        withoutAbortSignal(options),
        orphanInstallLockCommand(options.host, fence.lockDir)
      )
    )
    forgetHeldKingudFence(fence.token)
  } catch (error) {
    // Best effort: the fence still holds; recovery then waits out the stale window as before.
    console.warn(
      `[kingud] Could not mark a retained activation fence as ownerless: ${String(error)}`
    )
  }
}

/** Whether any lock is held; a lost probe throws rather than reading as open. */
export async function kingudActivationFenceExists(
  options: KingudActivationLockOptions
): Promise<boolean> {
  const lockDir = kingudActivationFenceLockDir(options.host, options.remoteHome)
  const answer = (
    await execKingudRemote(options, probeInstallLockExistsCommand(options.host, lockDir))
  ).trim()
  if (answer !== 'LOCKED' && answer !== 'OPEN') {
    throw new Error('The activation fence probe returned no verifiable answer.')
  }
  return answer === 'LOCKED'
}

/** Drops the fence `token` names, and nothing else: a successor's fence carries its own token. */
export function releaseKingudActivationFence(
  options: KingudActivationLockOptions,
  token: string
): Promise<void> {
  return releaseActivationFence(options, activationFence(options, token))
}

/**
 * Conditional on the host: only while the lock still carries this run's token, journal first,
 * then the lock renamed aside and removed, so a successor's fresh lock is never what goes.
 */
async function releaseActivationFence(
  options: KingudActivationLockOptions,
  fence: KingudFence
): Promise<void> {
  const lockRoot = kingudActivationTransactionRoot(options.host, options.remoteHome)
  const journal = kingudActivationTransactionPath(options.host, options.remoteHome)
  // Why no signal: a cancelled run must still be able to drop a fence it proved unnecessary.
  const target = withoutAbortSignal(options)
  const command = isWindowsRemoteHost(options.host)
    ? kingudWindowsHomeOpCommand(options.host, options.remoteHome, 'fence-release', [
        fence.lockDir,
        journal,
        fence.token
      ])
    : posixReleaseFenceCommand(fence, journal, lockRoot)
  const answer = (await execKingudRemote(target, command)).trim()
  forgetHeldKingudFence(fence.token)
  if (answer.endsWith('SUPERSEDED')) {
    console.warn('[kingud] A newer run had taken this activation fence over; it was left in place.')
  }
}

/**
 * Each piece is renamed aside first and kept only if it is ours, else put straight back: a release
 * that stalls after its token check can then never delete a successor's journal or lock.
 */
function posixReleaseFenceCommand(fence: KingudFence, journal: string, lockRoot: string): string {
  const lock = shellEscape(fence.lockDir)
  const journalPath = shellEscape(journal)
  const stamp = shellEscape(journalFenceStamp(fence.token))
  return [
    `${posixKingudFenceOwnedTest(fence)} || { echo SUPERSEDED; exit 0; };`,
    `ja=${journalPath}.release.$$;`,
    `if mv ${journalPath} "$ja" 2>/dev/null; then`,
    `grep -qF ${stamp} "$ja" || mv -n "$ja" ${journalPath} 2>/dev/null; rm -f "$ja"; fi;`,
    `la=${lock}.released.$$;`,
    `if mv ${lock} "$la" 2>/dev/null; then`,
    `if [ "$(cat "$la"/${KINGUD_FENCE_OWNER_FILENAME} 2>/dev/null)" = ${shellEscape(fence.token)} ]; then rm -rf "$la";`,
    `else mv -n "$la" ${lock} 2>/dev/null; fi; fi;`,
    `rmdir ${shellEscape(lockRoot)} 2>/dev/null; echo RELEASED`
  ].join(' ')
}

/** How a journal this generation wrote names it (see writeKingudActivationTransaction). */
function journalFenceStamp(token: string): string {
  return `"fenceToken": ${JSON.stringify(token)}`
}
