import { KingudBindAddressError } from './kingud-bind-address'
import { KingudBundledRuntimeError } from './kingud-bundled-runtime'
import { KingudInstanceLockError } from './kingud-instance-lock'
import { ProfileStateAccessError } from '../persistence/profile-state/profile-state-access'

export const KINGUD_EXIT_OK = 0
export const KINGUD_EXIT_FAILED = 1
export const KINGUD_EXIT_CONFIGURATION = 78

/** Configuration faults cannot be repaired by a supervisor restart. */
export function resolveKingudExitCode(error: unknown): number {
  return error instanceof KingudInstanceLockError ||
    error instanceof KingudBindAddressError ||
    error instanceof KingudBundledRuntimeError ||
    error instanceof ProfileStateAccessError
    ? KINGUD_EXIT_CONFIGURATION
    : KINGUD_EXIT_FAILED
}
