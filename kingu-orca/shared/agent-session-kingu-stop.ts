// Why the Kingu running a chat stopped in the middle of a reply: a quit, an update, or a crash. The
// host states it on its row about the cut turn (`kinguStop`); a client names it, and offers Continue.
// Open on the wire: a cause this build does not know reads as none, and the row keeps its words.

export const AGENT_SESSION_KINGU_STOP_CAUSES = ['update', 'quit', 'crash'] as const
/** The row's presentation, so a client that re-words host rows it can't name passes it through. */
export const AGENT_SESSION_KINGU_STOP_PRESENTATION = 'kingu-stop'
export type AgentSessionKinguStopCause = (typeof AGENT_SESSION_KINGU_STOP_CAUSES)[number]
export type AgentSessionKinguStop = { cause: AgentSessionKinguStopCause }

export function isAgentSessionKinguStopCause(value: unknown): value is AgentSessionKinguStopCause {
  return AGENT_SESSION_KINGU_STOP_CAUSES.some((cause) => cause === value)
}

/** The stop a row states, when this build knows its cause. */
export function readAgentSessionKinguStop(value: unknown): AgentSessionKinguStop | undefined {
  const cause =
    typeof value === 'object' && value !== null && 'cause' in value ? value.cause : undefined
  return isAgentSessionKinguStopCause(cause) ? { cause } : undefined
}
