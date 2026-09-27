import { isAgentSessionId } from './agent-session-record'

/**
 * The Kingu session id is the id Kingu minted for a structured session (its session record id), never
 * the provider's own session id. Orchestration stores, bare, the one the agent is addressed by: for
 * a `/clear`ed chat, its lineage root's, not the live session's. Mail addresses the session as
 * `session:<id>`, beside `run:<id>` and `dispatch:<id>`, and derives that spelling here rather than
 * storing it.
 *
 * Where the session runs is not part of the id; it is read from the session record when needed. PTY
 * agents have none today, and never a pane-keyed one: a pane outlives the agent in it, so such an id
 * would be inherited by the pane's next occupant.
 */
export const KINGU_SESSION_ADDRESS_PREFIX = 'session:'

declare const kinguSessionIdBrand: unique symbol
declare const kinguSessionAddressBrand: unique symbol

/** A bare Kingu session id; only `isKinguSessionId` and `parseKinguSessionAddress` produce one. */
export type KinguSessionId = string & { readonly [kinguSessionIdBrand]: true }
/** A `session:<id>` mail address; only `formatKinguSessionAddress` produces one. */
export type KinguSessionAddress = string & { readonly [kinguSessionAddressBrand]: true }

// Terminal handles (`term_` from the PTY runtime, `structworker_` from structured-worker-identity)
// share the session-id charset. A handle is never a session, so one handed over by mistake must not
// become a durable Kingu session id.
const TERMINAL_HANDLE_PREFIXES = ['term_', 'structworker_'] as const

export function isKinguSessionId(id: string): id is KinguSessionId {
  return isAgentSessionId(id) && !TERMINAL_HANDLE_PREFIXES.some((prefix) => id.startsWith(prefix))
}

export function formatKinguSessionAddress(kinguSessionId: KinguSessionId): KinguSessionAddress {
  const address = `${KINGU_SESSION_ADDRESS_PREFIX}${kinguSessionId}`
  // Always true for a checked id; the check brands the address without a type assertion.
  if (!isKinguSessionAddress(address)) {
    throw new Error(`Not an Kingu session id: ${kinguSessionId}`)
  }
  return address
}

/** The bare Kingu session id of a `session:<id>` address; anything else reads as null. */
export function parseKinguSessionAddress(
  address: string | null | undefined
): KinguSessionId | null {
  if (!address?.startsWith(KINGU_SESSION_ADDRESS_PREFIX)) {
    return null
  }
  const id = address.slice(KINGU_SESSION_ADDRESS_PREFIX.length)
  return isKinguSessionId(id) ? id : null
}

function isKinguSessionAddress(address: string): address is KinguSessionAddress {
  return parseKinguSessionAddress(address) !== null
}
