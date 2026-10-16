/**
 * Idle exit for an kingud a client launched over SSH, matching the relay: a host nobody has
 * used for 15 minutes stops its server, and the next connect starts it again.
 */
import { z } from 'zod'

export { KINGUD_MANAGED_ACTIVATION_ROOT_ENV } from './kingud-managed-launch-env'
/** Test-only quiet period; a client forwards it to the servers it launches. */
export const KINGUD_E2E_IDLE_TIMEOUT_ENV = 'KINGU_E2E_KINGUD_IDLE_TIMEOUT_MS'
export const KINGUD_IDLE_EXIT_TIMEOUT_MS = 15 * 60_000
const KINGUD_E2E_IDLE_TIMEOUT_MAX_MS = 60 * 60_000

/** The bounded test override, or null when unset or out of range. */
export function readKingudE2EIdleTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const raw = env[KINGUD_E2E_IDLE_TIMEOUT_ENV]
  const value = raw ? Number(raw) : Number.NaN
  return Number.isSafeInteger(value) && value >= 1 && value <= KINGUD_E2E_IDLE_TIMEOUT_MAX_MS
    ? value
    : null
}

/** Written to the data root just before an idle stop; the next start reports and clears it. */
export const KINGUD_IDLE_STOP_RECORD_FILENAME = 'kingud-idle-stop.json'

export const KingudIdleStopRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('kingud_idle_stop'),
  pid: z.number().int().positive(),
  version: z.string().max(255),
  quietSince: z.iso.datetime({ offset: true }),
  stoppedAt: z.iso.datetime({ offset: true }),
  idleTimeoutMs: z.number().int().positive()
})

export type KingudIdleStopRecord = z.infer<typeof KingudIdleStopRecordSchema>
