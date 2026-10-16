import { KingudBindAddressError } from './kingud-bind-address'
import { KingudBundledRuntimeError } from './kingud-bundled-runtime'
import { KingudInstanceLockError } from './kingud-data-root-privacy'
import { ProfileStateAccessError } from '../persistence/profile-state/profile-state-access'
import { KINGUD_EXIT_CONFIGURATION } from './kingud-configuration-exit'

export const KINGUD_EXIT_FAILED = 1

/** Configuration faults cannot be repaired by a supervisor restart. */
export function resolveKingudExitCode(error: unknown): number {
  return error instanceof KingudInstanceLockError ||
    error instanceof KingudBindAddressError ||
    error instanceof KingudBundledRuntimeError ||
    error instanceof ProfileStateAccessError
    ? KINGUD_EXIT_CONFIGURATION
    : KINGUD_EXIT_FAILED
}
