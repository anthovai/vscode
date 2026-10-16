/** Kept dependency-free: the short-lived stop-completion command imports these too. */
export const KINGUD_SHUTDOWN_DEADLINE_MS = 15_000
export const KINGUD_DAEMON_RETIREMENT_TIMEOUT_MS = 5_000

export const KINGUD_STOP_COMPLETION_POLL_MS = 250
// Retirement (request + session count, each bounded) runs before the shutdown deadline starts.
const STOP_COMPLETION_BUDGET_MS =
  2 * KINGUD_DAEMON_RETIREMENT_TIMEOUT_MS + KINGUD_SHUTDOWN_DEADLINE_MS + 5_000
export const KINGUD_STOP_COMPLETION_POLL_ATTEMPTS = Math.ceil(
  STOP_COMPLETION_BUDGET_MS / KINGUD_STOP_COMPLETION_POLL_MS
)
