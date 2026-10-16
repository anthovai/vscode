/**
 * An agent session named as a recipient: `kingu_session_id:<id>`, or a bare Kingu session id. Any session on
 * this host can be addressed, not only one that coordinates a Run: an agent's id is its public
 * address, and a user telling one agent to message another's id is a supported workflow.
 *
 * Mail that no Run or Dispatch owns is stored at the conversation's `kingu_session_id:<root id>` and pointed
 * at its live session as a turn, so any session of a `/clear` lineage is a valid spelling. A
 * released lease is not a refusal (the pointer's send starts its agent); a closed chat, another host,
 * and an unknown id are, before anything is stored.
 */

import {
  KINGU_SESSION_ADDRESS_PREFIX,
  formatKinguSessionAddress,
  isKinguSessionId,
  parseKinguSessionAddress,
  type KinguSessionAddress,
  type KinguSessionId
} from '../../../../../../shared/kingu-session-address'
// The caller codes, reused: each names the same fact about a session, whichever side of the mail it is on.
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../../../../shared/orchestration-session-caller-codes'
import {
  lookupKinguAgentSession,
  structuredSessionMailReach
} from '../../../../orchestration/structured-session-mail-address'
import type { AgentSessionRecordReader } from '../../../../orchestration/structured-session-lineage'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { canonicalKinguSessionId } from '../../../../orchestration/canonical-kingu-session-id'

/** `address` is the named session's own spelling; the mailbox mail lands in is its identity address. */
export type SessionRecipient = { sessionId: KinguSessionId; address: KinguSessionAddress }

export type SessionRecipientRefusal = {
  code: (typeof CODES)[keyof typeof CODES]
  message: string
}

/** Whether a recipient may name a session, so the caller can install the session host first. */
export function mayNameSession(recipient: string): boolean {
  return recipient.startsWith(KINGU_SESSION_ADDRESS_PREFIX) || isKinguSessionId(recipient)
}

/**
 * The session a recipient names. A bare string names a session only when it is an Kingu session id
 * this host has a record for; anything else stays a terminal handle, exactly as before.
 */
export function readSessionRecipient(
  recipient: string,
  store: AgentSessionRecordReader | null
): SessionRecipient | SessionRecipientRefusal | null {
  if (recipient.startsWith(KINGU_SESSION_ADDRESS_PREFIX)) {
    const sessionId = parseKinguSessionAddress(recipient)
    return sessionId
      ? { sessionId, address: formatKinguSessionAddress(sessionId) }
      : {
          code: CODES.unknown,
          message: `${recipient} does not name an Kingu session ID. No message was sent.`
        }
  }
  const sessionId = isKinguSessionId(recipient) ? recipient : null
  const found = sessionId && store ? lookupKinguAgentSession(store, sessionId) : null
  if (found?.kind === 'provider-id') {
    return providerIdRefusal(recipient, found.kinguSessionId, store)
  }
  return sessionId && found?.kind === 'found'
    ? { sessionId, address: formatKinguSessionAddress(sessionId) }
    : null
}

/**
 * Null when mail to this session can be stored and delivered here; otherwise why not. A Dispatch
 * to a chat asks the same question, since its task and its mail reach the chat the same way.
 */
export function refuseUndeliverableSessionRecipient(
  recipient: SessionRecipient,
  store: AgentSessionRecordReader | null,
  db: OrchestrationDb,
  noEffect = 'No message was sent.'
): SessionRecipientRefusal | null {
  const { sessionId } = recipient
  if (!store) {
    return {
      code: CODES.unknown,
      message: `Agent session ${sessionId} cannot be verified: this Kingu is not running its agent-session host. ${noEffect}`
    }
  }
  const found = lookupKinguAgentSession(store, sessionId)
  if (found.kind === 'provider-id') {
    return providerIdRefusal(sessionId, found.kinguSessionId, store, noEffect)
  }
  if (found.kind === 'unknown') {
    return {
      code: CODES.unknown,
      message: `No Kingu agent session ${sessionId} exists on this host. ${noEffect}`
    }
  }
  const reach = structuredSessionMailReach(store, found.record, db)
  if (reach.kind === 'other-host') {
    return {
      code: CODES.hostBoundary,
      message: `Agent session ${sessionId} runs on another host; mail reaches a session only on the host that runs it. Send from that host. ${noEffect}`
    }
  }
  if (reach.kind === 'unverifiable') {
    return {
      code: CODES.notLive,
      message: `The session continuing agent session ${sessionId} after a /clear cannot be verified: ${reach.reason} ${noEffect}`
    }
  }
  if (reach.kind === 'ended') {
    return {
      code: CODES.notLive,
      message:
        reach.reason === 'worker-identity-lost'
          ? `Agent session ${sessionId} is a structured worker whose worker identity this host no longer has, so it can never read that mail. ${noEffect}`
          : `Agent session ${sessionId} has ended: its chat was closed. ${noEffect}`
    }
  }
  return null
}

function providerIdRefusal(
  id: string,
  kinguSessionId: string,
  store: AgentSessionRecordReader | null,
  noEffect = 'No message was sent.'
): SessionRecipientRefusal {
  // The conversation's Kingu session ID, which a `/clear`ed session keeps; not the live session's.
  const root = isKinguSessionId(kinguSessionId)
    ? canonicalKinguSessionId(kinguSessionId, store)
    : kinguSessionId
  const address = `${KINGU_SESSION_ADDRESS_PREFIX}${root}`
  return {
    code: CODES.providerId,
    message: `${id} is the provider's own session id, which changes on /clear. This session's Kingu session ID is ${address}; address it by that instead. ${noEffect}`
  }
}
