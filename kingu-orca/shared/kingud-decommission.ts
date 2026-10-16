/** What a client learns from decommissioning a managed kingud. */
import type { KingudManagedRefusal } from './kingud-managed-runtime'
import type { KingudDaemonRetirementVerdict } from './kingud-stop-request'

export type KingudDecommissionResult =
  | {
      outcome: 'decommissioned'
      version: string
      /** The daemon's fate: `retired`, or kept with its terminals (`live`/`unverifiable`). */
      retirement: KingudDaemonRetirementVerdict
    }
  | KingudManagedRefusal
