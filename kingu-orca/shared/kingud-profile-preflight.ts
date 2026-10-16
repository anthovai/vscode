import { z } from 'zod'

export const KINGUD_PROFILE_PREFLIGHT_FLAG = '--kingud-profile-state-preflight'
export const KINGUD_STARTUP_PREFLIGHT_FLAG = '--kingud-startup-preflight'
export const KINGUD_PROFILE_PREFLIGHT_TIMEOUT_MS = 90_000
// Server startup follows the disposable native/SQLite probe on every bundled launch.
export const KINGUD_STARTUP_READINESS_TIMEOUT_MS = KINGUD_PROFILE_PREFLIGHT_TIMEOUT_MS + 90_000

export const KINGUD_PREFLIGHT_RUNTIMES = ['node', 'bun'] as const

/** The runtime the caller launched; the candidate must prove it ran under exactly this one. */
export type KingudPreflightRuntimeIdentity = {
  runtime: (typeof KINGUD_PREFLIGHT_RUNTIMES)[number]
  runtimeVersion: string
}

export const kingudProfilePreflightResponseSchema = z.object({
  type: z.literal('kingu_profile_state_ready'),
  nonce: z.string().uuid(),
  runtime: z.enum(KINGUD_PREFLIGHT_RUNTIMES),
  runtimeVersion: z.string().min(1),
  artifactVersion: z.string().regex(/^\d+\.\d+\.\d+\+[a-f0-9]{12}$/),
  sqliteVersion: z.string().min(1),
  revision: z.number().int().positive()
})

export type KingudProfilePreflightResponse = z.infer<typeof kingudProfilePreflightResponseSchema>

/** A fresh challenge prevents stale or unrelated output from admitting a candidate. */
export function parseKingudProfilePreflight(
  output: string,
  nonce: string,
  expected: KingudPreflightRuntimeIdentity,
  artifactVersion?: string
): KingudProfilePreflightResponse {
  const response = kingudProfilePreflightResponseSchema.parse(JSON.parse(output.trim()))
  if (
    response.nonce !== nonce ||
    response.runtime !== expected.runtime ||
    response.runtimeVersion !== expected.runtimeVersion ||
    (artifactVersion !== undefined && response.artifactVersion !== artifactVersion)
  ) {
    throw new Error('Profile preflight did not run under the expected candidate runtime')
  }
  return response
}
