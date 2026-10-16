/**
 * The managed-server actions the Managed servers settings run, published by the desktop main
 * process so runtime RPC can offer the same ones. A runtime with none registered (headless
 * `kingu serve`) has no SSH registry to manage servers from, and does not advertise them.
 */
import type {
  KingudManagedCancelStopResult,
  KingudManagedDeployResult,
  KingudManagedForgetResult,
  KingudManagedRecoveryResult,
  KingudManagedRollbackResult,
  KingudManagedRuntimeStatus,
  KingudManagedStopResult
} from '../../shared/kingud-managed-runtime'

export type ManagedServerActions = {
  status: (selector: string) => Promise<KingudManagedRuntimeStatus>
  update: (selector: string, force: boolean) => Promise<KingudManagedDeployResult>
  rollback: (selector: string) => Promise<KingudManagedRollbackResult>
  /** `acceptChangedState` restores the snapshot over state a rejected build changed. */
  recover: (selector: string, acceptChangedState?: boolean) => Promise<KingudManagedRecoveryResult>
  stop: (selector: string) => Promise<KingudManagedStopResult>
  cancelStop: (selector: string) => Promise<KingudManagedCancelStopResult>
  /** Unlinks a server whose host cannot answer, without stopping it there. */
  forget: (selector: string) => Promise<KingudManagedForgetResult>
}

let registered: ManagedServerActions | null = null

export function registerManagedServerActions(actions: ManagedServerActions | null): void {
  registered = actions
}

export function getManagedServerActions(): ManagedServerActions | null {
  return registered
}
