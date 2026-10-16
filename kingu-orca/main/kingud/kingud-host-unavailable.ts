/**
 * Deploy failures that mean managed kingud can't run on this host at all, as opposed to failures
 * a later connect may not hit again. Only these send a host back to the pinned-relay ladder.
 */

/** No kingud build exists for this host's platform or target. */
export class KingudHostUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KingudHostUnsupportedError'
  }
}

/** This build carries no kingud template (dev builds): retried once the app version changes. */
export class KingudArtifactsUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KingudArtifactsUnavailableError'
  }
}

/** The host refuses port forwarding and can't run the stdio bridge either. */
export class KingudStdioBridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KingudStdioBridgeUnavailableError'
  }
}

export const KINGUD_TUNNEL_UNAVAILABLE_REASON = 'ssh_tunnel_unavailable'
export const KINGUD_WINDOWS_LAUNCH_REFUSED_CODE = 'kingud_windows_launch_refused'
export const KINGUD_WINDOWS_COMMAND_LINE_UNSAFE_CODE = 'kingud_windows_command_line_unsafe'

export type KingudHostUnavailableReason =
  | 'unsupported_host'
  | 'artifacts_unavailable'
  | 'libc_unidentified'
  | 'runtime_self_test'
  | 'security_software'
  | 'native_preflight'
  | typeof KINGUD_TUNNEL_UNAVAILABLE_REASON

const UNAVAILABLE_BY_ERROR_NAME: Record<string, KingudHostUnavailableReason> = {
  KingudHostUnsupportedError: 'unsupported_host',
  KingudArtifactsUnavailableError: 'artifacts_unavailable',
  KingudRemoteLaunchUnsupportedError: 'unsupported_host',
  UnidentifiedHostLibcError: 'libc_unidentified',
  RemoteNodeRuntimeSelfTestError: 'runtime_self_test',
  RemoteNodeRuntimeSecurityModifiedError: 'security_software',
  KingudStdioBridgeUnavailableError: KINGUD_TUNNEL_UNAVAILABLE_REASON,
  KingudWindowsLaunchRefusedError: 'unsupported_host',
  KingudWindowsCommandLineError: 'unsupported_host'
}

// Why only these deferrals: the candidate's native preflight (libc floor, missing libraries), its
// PTY self-test and a Windows launch refusal fail the same way on every retry; races don't.
const UNAVAILABLE_BY_DEFERRAL_CODE: Record<string, KingudHostUnavailableReason> = {
  kingud_candidate_preflight_failed: 'native_preflight',
  kingud_activation_pty_self_test_failed: 'native_preflight',
  [KINGUD_WINDOWS_LAUNCH_REFUSED_CODE]: 'unsupported_host',
  [KINGUD_WINDOWS_COMMAND_LINE_UNSAFE_CODE]: 'unsupported_host'
}

/** The deferral code for a candidate launch failure, keeping the permanent Windows refusals. */
export function kingudCandidateLaunchFailureCode(error: unknown): string {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return code === KINGUD_WINDOWS_LAUNCH_REFUSED_CODE ||
    code === KINGUD_WINDOWS_COMMAND_LINE_UNSAFE_CODE
    ? code
    : 'kingud_candidate_launch_failed'
}

export function classifyKingudHostUnavailable(
  failure: unknown
): KingudHostUnavailableReason | null {
  if (failure instanceof Error) {
    return UNAVAILABLE_BY_ERROR_NAME[failure.name] ?? null
  }
  if (failure && typeof failure === 'object' && 'code' in failure) {
    const code = failure.code
    return typeof code === 'string' ? (UNAVAILABLE_BY_DEFERRAL_CODE[code] ?? null) : null
  }
  return null
}
