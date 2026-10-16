/**
 * Removing a WSL host ends what Kingu runs in its distro: each terminal (through kingud's own
 * terminal RPC, by handle, so a terminal whose project is already gone still closes), then kingud
 * and its terminal daemon through the managed decommission SSH hosts use (`--complete-managed-stop`
 * with `retireIdleDaemon`). It reports "stopped" only on proof: the census says no session is
 * left, the decommission addressed the very kingud the bridge was serving, and the daemon retired.
 */
import { z } from 'zod'
import { errorMessage } from '../../shared/error-message'
import type { KingudDecommissionResult } from '../../shared/kingud-decommission'
import { KINGUD_MANAGED_REMOTE_PORT } from '../../shared/kingud-managed-runtime'
import type { KingudTerminalCensus } from '../../shared/kingud-terminal-census'
import type { RuntimeTerminalListResult } from '../../shared/runtime-terminal-contracts'
import type { WslHostServerStop } from '../../shared/wsl-host-types'
import type { KingudHostTransport } from '../ssh/kingud-host-transport'
import { readRemoteKingudManagedStopTarget } from '../ssh/kingud-managed-remote-stop'
import { managedKingudSlot } from '../ssh/kingud-managed-runtime-context'
import { resolveKingudRemoteContext } from '../ssh/kingud-remote-context'
import { decommissionRemoteKingud } from '../ssh/kingud-remote-decommission'
import type { WslKingudHostTarget } from './wsl-kingud-host-target'

const CENSUS_ATTEMPTS = 20
const CENSUS_INTERVAL_MS = 250

/** A terminal Kingu asked to close but that may still run, named so the user can find it. */
export type WslHostTerminalLeftover = { handle: string; worktreeId: string; reason: string }

export type WslHostServerStopSteps = {
  /** Closes every terminal kingud runs; returns the ones that refused instead of stopping. */
  endTerminals: () => Promise<WslHostTerminalLeftover[]>
  census: () => Promise<KingudTerminalCensus>
  /** The runtime id of the kingud the bridge is serving; read before the bridge closes. */
  servingRuntimeId: () => Promise<string | null>
  /** After the bridge closed: liveness must not see this exit as a crash to recover. */
  closeBridge: () => Promise<void>
  decommission: (
    census: KingudTerminalCensus,
    servingRuntimeId: string | null
  ) => Promise<KingudDecommissionResult>
  sleep?: (ms: number) => Promise<void>
}

function describeLeftovers(leftovers: readonly WslHostTerminalLeftover[]): string {
  return leftovers
    .map((leftover) => `${leftover.handle} (${leftover.worktreeId}): ${leftover.reason}`)
    .join('; ')
}

export async function stopWslHostServer(steps: WslHostServerStopSteps): Promise<WslHostServerStop> {
  const sleep = steps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const problems: string[] = []
  let leftovers: WslHostTerminalLeftover[] = []
  try {
    leftovers = await steps.endTerminals()
  } catch (error) {
    problems.push(`Kingu couldn’t list the host’s terminals: ${errorMessage(error)}`)
  }
  // Shells take a moment to exit after their PTYs close; the census is the proof they did.
  let census = await steps.census()
  for (let attempt = 1; attempt < CENSUS_ATTEMPTS && census.liveSessions !== 0; attempt += 1) {
    await sleep(CENSUS_INTERVAL_MS)
    census = await steps.census()
  }
  const servingRuntimeId = await steps.servingRuntimeId().catch(() => null)
  await steps.closeBridge()
  if (leftovers.length > 0) {
    problems.push(`Terminals that refused to close: ${describeLeftovers(leftovers)}`)
  }
  if (census.liveSessions !== 0) {
    problems.push(
      census.liveSessions === null
        ? 'The terminal daemon did not answer a session count.'
        : `${census.liveSessions} terminal session${census.liveSessions === 1 ? '' : 's'} kept running.`
    )
  }
  // Why decommission even now: it refuses on live sessions by design, and its reason is the proof.
  const result = await steps.decommission(census, servingRuntimeId)
  if (result.outcome === 'refused') {
    problems.push(`Kingu’s server kept running: ${result.reason}`)
  } else if (result.retirement !== 'retired') {
    problems.push('Kingu’s server stopped, but its terminal daemon is still running.')
  }
  return problems.length === 0 ? { stopped: true } : { stopped: false, reason: problems.join(' ') }
}

/**
 * How removal reaches the host's kingud: by environment id, through the same routed transport and
 * saved pairing every other call to the host uses (the bridge's raw pairing offer is not it).
 */
export type WslHostRuntimeAccess = {
  call: (environmentId: string, method: string, params: unknown) => Promise<unknown>
  census: (environmentId: string) => Promise<KingudTerminalCensus>
}

// Only what removal reads from each live terminal.
const TerminalHandlesSchema = z.object({
  terminals: z.array(z.object({ handle: z.string().min(1), worktreeId: z.string() }))
}) satisfies z.ZodType<{
  terminals: Pick<RuntimeTerminalListResult['terminals'][number], 'handle' | 'worktreeId'>[]
}>

const RuntimeIdSchema = z.object({ runtimeId: z.string().min(1) })

/** Closing terminals, counting what is left and naming the serving kingud, all through its RPC. */
export function wslHostRuntimeStopSteps(
  access: WslHostRuntimeAccess,
  environmentId: string
): Pick<WslHostServerStopSteps, 'endTerminals' | 'census' | 'servingRuntimeId'> {
  return {
    endTerminals: async () => {
      const list = TerminalHandlesSchema.parse(
        await access.call(environmentId, 'terminal.list', { limit: 1000 })
      )
      const leftovers: WslHostTerminalLeftover[] = []
      // Why by handle: a workspace selector fails once its project is gone (`selector_not_found`),
      // and one failure must not keep the rest, or the server, running.
      for (const terminal of list.terminals) {
        try {
          await access.call(environmentId, 'terminal.close', { terminal: terminal.handle })
        } catch (error) {
          leftovers.push({ ...terminal, reason: errorMessage(error) })
        }
      }
      return leftovers
    },
    census: () => access.census(environmentId),
    servingRuntimeId: async () =>
      RuntimeIdSchema.parse(await access.call(environmentId, 'status.get', undefined)).runtimeId
  }
}

/**
 * The managed decommission, over wsl.exe rather than the bridge (closed by then). It first checks
 * that the instance the host records as active is the one the bridge was serving; a re-add can
 * adopt an kingud the record does not name, and stopping the named one would prove nothing.
 */
export function decommissionWslHostKingud(
  target: WslKingudHostTarget,
  transport: KingudHostTransport
): WslHostServerStopSteps['decommission'] {
  return async (census, servingRuntimeId) => {
    const context = await resolveKingudRemoteContext(target, transport)
    const slot = managedKingudSlot(context, KINGUD_MANAGED_REMOTE_PORT)
    const active = context.activationRecord.active
    if (active) {
      const stopTarget = await readRemoteKingudManagedStopTarget(slot, active)
      const recordedRuntimeId = stopTarget.state === 'ready' ? stopTarget.context.runtimeId : null
      if (!servingRuntimeId || recordedRuntimeId !== servingRuntimeId) {
        return {
          outcome: 'refused',
          verdict: 'unverifiable',
          code: 'kingud_wsl_host_serving_instance_unproven',
          reason:
            'the kingud this computer was connected to is not the one the distro records as active, so Kingu could not prove it stopped.'
        }
      }
    }
    return decommissionRemoteKingud({ ...slot, record: context.activationRecord, census })
  }
}
