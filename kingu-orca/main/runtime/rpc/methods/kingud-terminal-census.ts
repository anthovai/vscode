import { defineMethod } from '../core'
import {
  KINGUD_TERMINAL_CENSUS_METHOD,
  KingudTerminalCensusParamsSchema,
  type KingudTerminalCensus
} from '../../../../shared/kingud-terminal-census'

export const KINGUD_TERMINAL_CENSUS_METHODS = [
  defineMethod({
    name: KINGUD_TERMINAL_CENSUS_METHOD,
    permission: 'host-admin',
    params: KingudTerminalCensusParamsSchema,
    handler: async (params, { runtime }) => {
      // Why lazy: the census reaches the daemon modules, whose xterm polyfill defines a global
      // `window`; importing them statically would load it into every process with the dispatcher.
      const { collectKingudTerminalCensus } = await import('../../../kingud/kingud-terminal-census')
      if (!params.releaseFinishedAutomationTerminals) {
        return collectKingudTerminalCensus(params.activatedAt)
      }
      const before = await collectKingudTerminalCensus(params.activatedAt)
      const released = await runtime.releaseFinishedAutomationRunTerminals()
      return settledCensus(
        () => collectKingudTerminalCensus(params.activatedAt),
        before.liveSessions === null ? null : before.liveSessions - released
      )
    }
  })
]

/** Closed sessions leave the daemon a moment after the close; wait briefly for the count to drop. */
async function settledCensus(
  collect: () => Promise<KingudTerminalCensus>,
  expectedAtMost: number | null
): Promise<KingudTerminalCensus> {
  let census = await collect()
  for (let attempt = 0; attempt < 15 && expectedAtMost !== null; attempt += 1) {
    if (census.liveSessions === null || census.liveSessions <= expectedAtMost) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    census = await collect()
  }
  return census
}
