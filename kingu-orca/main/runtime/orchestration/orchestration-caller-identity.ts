import type { RunRow } from './types'
import { isEquivalentPaneKey } from './db/pane-key-match'
import { currentRunCoordinatorKinguSessionId } from './db/runs/run-coordinator-kingu-session'
import {
  formatKinguSessionAddress,
  type KinguSessionId
} from '../../../shared/kingu-session-address'

/**
 * Who an orchestration caller is, as Run binding and mail routing match it.
 *
 * A PTY agent is its terminal: a handle and a pane key, no Kingu session id. An agent that is a
 * structured session is its Kingu session id, addressed as `session:<id>`; a structured worker also
 * has the handle and pane key it was minted, and an ordinary chat has neither. Methods pass this
 * through whole and never branch on which fields are set; the lookups below own that.
 */
export type OrchestrationCallerIdentity = Readonly<{
  /** Mailbox address the caller sends from and reads: its terminal handle, else its session address. */
  address: string
  terminalHandle: string | null
  paneKey: string | null
  /** The bare Kingu session id the caller is addressed by; mail spells it `session:<id>`. */
  kinguSessionId: KinguSessionId | null
}>

/** The part of a caller a Run binding stores and matches. */
export type OrchestrationCoordinatorKey = Pick<
  OrchestrationCallerIdentity,
  'terminalHandle' | 'paneKey' | 'kinguSessionId'
>

/** A caller the dispatch entry resolved from the Kingu session id in its injected environment. */
export type OrchestrationSessionCaller = OrchestrationCallerIdentity &
  Readonly<{
    kinguSessionId: KinguSessionId
    /** The session record the request came from. */
    sessionId: KinguSessionId
    /** Where the session runs, from its record; `worker-start --worktree current` places here. */
    workspaceId: string
  }>

/** A caller with neither a pane nor an Kingu session id can never be bound to a Run. */
export function hasRunBindingKey(caller: OrchestrationCoordinatorKey): boolean {
  return caller.paneKey !== null || caller.kinguSessionId !== null
}

/** The one address a party reads mail at and is sent mail at; null for a key naming nobody. */
export function mailboxAddressOf(
  party: Pick<OrchestrationCoordinatorKey, 'terminalHandle' | 'kinguSessionId'>
): string | null {
  // Handle first because a worker's mail and Dispatch rows are keyed by it today; flips when sessions become canonical.
  if (party.terminalHandle !== null) {
    return party.terminalHandle
  }
  return party.kinguSessionId === null ? null : formatKinguSessionAddress(party.kinguSessionId)
}

/** Who a Run's binding names now; an Kingu session id an older binding left behind is not part of it. */
export function runCoordinatorKey(run: RunRow): OrchestrationCoordinatorKey {
  return {
    terminalHandle: run.coordinator_handle,
    paneKey: run.coordinator_pane_key,
    kinguSessionId: currentRunCoordinatorKinguSessionId(run)
  }
}

export function runBoundToCoordinator(run: RunRow, caller: OrchestrationCoordinatorKey): boolean {
  if (
    caller.paneKey !== null &&
    run.coordinator_pane_key !== null &&
    isEquivalentPaneKey(run.coordinator_pane_key, caller.paneKey)
  ) {
    return true
  }
  return (
    caller.kinguSessionId !== null &&
    currentRunCoordinatorKinguSessionId(run) === caller.kinguSessionId
  )
}
