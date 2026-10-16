import type { KingudManagedStopRequest } from '../../shared/kingud-stop-request'
import { persistKingudDaemonRetirementRecord } from './kingud-completed-stop-receipt'
import type { KingudDaemonRetirement } from './kingud-daemon-retirement'
import { stopKingudAutomationScheduler } from './kingud-automations'

// Lazy like the rest of kingud's daemon graph: the entry module must not load it at import time.
async function retireLazily(): Promise<KingudDaemonRetirement> {
  const { retireKingudDaemonIfIdle } = await import('./kingud-daemon-retirement')
  return retireKingudDaemonIfIdle()
}

/** Runs before kingud stops for a managed request; it can record an outcome but never veto. */
export async function prepareKingudManagedStop(
  request: KingudManagedStopRequest,
  retire: () => Promise<KingudDaemonRetirement> = retireLazily,
  stopAutomations: () => void = stopKingudAutomationScheduler
): Promise<void> {
  // First, so no dispatch races the census below or writes a run the stop then discards.
  stopAutomations()
  if (!request.retireIdleDaemon) {
    return
  }
  const outcome = await retire().catch((error: unknown): KingudDaemonRetirement => ({
    retirement: 'unverifiable',
    liveSessions: null,
    reason: `Retirement failed: ${error instanceof Error ? error.message : String(error)}`
  }))
  try {
    persistKingudDaemonRetirementRecord(request, outcome)
  } catch (error) {
    // The completion command reads a missing record as `unverifiable`.
    console.error('[kingud] could not record daemon retirement:', error)
  }
}
