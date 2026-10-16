import type { PublicKnownRuntimeEnvironment } from './runtime-environments'
import type { KingudTerminalCensus } from './kingud-terminal-census'
import type { KingudMigrationBlocker } from './kingud-migration-preflight'
import type { KingudMigrationSourceCutoverPhase } from './kingud-migration-source-cutover'
import type { KingudDaemonRetirementVerdict } from './kingud-stop-request'
import type { SshManagedServerLinkedProject } from './ssh-types'

export const KINGUD_MANAGED_REMOTE_PORT = 6_768

/** Refused because terminals are, or may be, still running on the host. */
export type KingudManagedRefusal = {
  outcome: 'refused'
  verdict: 'live' | 'unverifiable'
  code: string
  reason: string
  /** Only saved state blocks, which a confirmed "Move anyway" leaves on this desktop. */
  canLeaveBehind?: true
}

export type KingudManagedDeferral = {
  outcome: 'deferred'
  candidateVersion: string
  code: string
  reason: string
  /** False when force cannot make the rejected lifecycle transition safe. */
  forceable?: boolean
}

export type KingudManagedDeployResult =
  | {
      outcome: 'created' | 'updated' | 'already-current'
      environment: PublicKnownRuntimeEnvironment
      activeVersion: string
    }
  | KingudManagedDeferral

export type KingudManagedRollbackResult =
  | {
      outcome: 'rolled-back'
      environment: PublicKnownRuntimeEnvironment
      activeVersion: string
      discarded: string[]
    }
  | { outcome: 'refused' | 'failed'; code: string; reason: string }

/** A recovery that needs the operator to accept restoring a snapshot over changed state. */
export const KINGUD_RECOVERY_CHANGED_STATE_CODE = 'kingud_recovery_changed_state'

export type KingudManagedRecoveryResult =
  | { outcome: 'none' }
  | { outcome: 'pending'; code: string; reason: string }
  | {
      outcome: 'recovered'
      resolution: 'committed' | 'restored-incumbent'
      activeVersion: string | null
      environment: PublicKnownRuntimeEnvironment
    }
  | KingudManagedRefusal

/** Only a proven `exited` unlinks the server locally; anything less keeps it linked. */
export type KingudManagedStopResult =
  | {
      outcome: 'unlinked'
      verdict: 'exited'
      environmentId: string
      sshTargetId: string
      stoppedVersion: string | null
      retirement: KingudDaemonRetirementVerdict | null
    }
  | KingudManagedRefusal

/**
 * Unlinks the server from this desktop without reaching its host, for a host that is gone or
 * unreachable. Never a claim of exit: the server may still run there, so the verdict stays
 * `unverifiable`.
 */
export type KingudManagedForgetResult =
  | {
      outcome: 'forgotten'
      verdict: 'unverifiable'
      environmentId: string
      sshTargetId: string
    }
  | KingudManagedRefusal

export type KingudManagedCancelStopResult =
  | { outcome: 'none' }
  /** The stop was withdrawn before kingud acted on it; the server keeps serving. */
  | { outcome: 'canceled'; activeVersion: string }
  /** kingud had already exited; finish with stop to unlink the server. */
  | { outcome: 'already-stopped' }
  | KingudManagedRefusal

export type KingudManagedRuntimeStatus = {
  environmentId: string
  sshTargetId: string
  activeVersion: string | null
  previousVersion: string | null
  activatedAt: string | null
  rollbackAvailable: boolean
  recovery:
    | {
        operation: 'activate'
        phase: 'prepared' | 'incumbent-stopped' | 'snapshot-captured' | 'candidate-ready'
        version: string
        startedAt: string
      }
    | {
        operation: 'rollback'
        phase:
          | 'prepared'
          | 'incumbent-stopped'
          | 'rescue-captured'
          | 'rollback-state-restored'
          | 'target-ready'
        version: string
        startedAt: string
      }
    | {
        operation: 'decommission'
        phase: 'prepared' | 'stop-dispatched' | 'process-exited'
        version: string
        startedAt: string
      }
    | null
  /** Terminals the daemon runs; `null` counts are unverifiable and block updates and stops. */
  terminals: KingudTerminalCensus
  /** An unfinished dormant migration into this server; a rollback is refused while it runs. */
  migration: {
    migrationId: string
    phase: KingudMigrationSourceCutoverPhase
    startedAt: string
  } | null
  /** The last update this client deferred for this server, cleared once one goes through. */
  deferredUpdate: (KingudManagedDeferral & { deferredAt: string }) | null
}

export type KingudManagedConversionResult =
  | {
      /** Committed on the server and retired from the SSH host. */
      outcome: 'converted'
      environment: PublicKnownRuntimeEnvironment
      migrationId: string
      /** Projects the server already held, so this desktop's own state for them did not move. */
      linkedProjects?: SshManagedServerLinkedProject[]
    }
  | KingudManagedDeferral
  | KingudManagedRefusal

export type KingudManagedPendingMigrationRow = {
  migrationId: string
  environmentId: string
  name: string
  sshTargetId: string
  phase: KingudMigrationSourceCutoverPhase
  startedAt: string
}

export type KingudDeltaMoveRow = {
  kind: 'repository' | 'folder-workspace' | 'project-group'
  id: string
  label: string
}

/** What moving a host's newer projects would add, and what the server will keep as it is. */
export type KingudDeltaMovePreview = {
  sshTargetId: string
  environmentId: string
  added: KingudDeltaMoveRow[]
  /** Projects an older build changed or removed; the server keeps its own copy of these. */
  notReflected: { edited: KingudDeltaMoveRow[]; removed: KingudDeltaMoveRow[] }
  blockers: KingudMigrationBlocker[]
}

export type KingudDeltaMoveResult =
  | { outcome: 'moved'; migrationId: string }
  | { outcome: 'refused'; code: string; reason: string; blockers?: KingudMigrationBlocker[] }
