import type { KinguSessionId } from './kingu-session-address'

/**
 * Who an orchestration party is, as Run binding and mail routing match it.
 *
 * A PTY agent is its terminal: a handle and a pane key, no Kingu session id. An agent that is a
 * structured session is its Kingu session id, addressed as `kingu_session_id:<id>`; a structured worker also
 * has the handle and pane key it was minted, and an ordinary chat has neither. Methods pass this
 * through whole and never branch on which fields are set; the lookups that build it own that.
 */
export type OrchestrationPartyIdentity = Readonly<{
  /** Mailbox address the party sends from and reads: its terminal handle, else its session address. */
  address: string
  terminalHandle: string | null
  paneKey: string | null
  /** The bare Kingu session id the party is addressed by; mail spells it `kingu_session_id:<id>`. */
  kinguSessionId: KinguSessionId | null
}>
