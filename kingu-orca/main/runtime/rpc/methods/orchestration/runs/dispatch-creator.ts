import type { DispatchCreator } from '../../../../orchestration/db/dispatch-depth'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import type { KinguRuntimeService } from '../../../../kingu-runtime'
import { orchestrationCallerIdentity } from './run-scope'

/**
 * Identify a CLI caller for nesting-depth purposes.
 *
 * Pane key and process incarnation come from the runtime's dispatch authority
 * rather than the caller's params: remote attachment matching needs the exact
 * incarnation, and a caller cannot be trusted to report its own.
 */
export function resolveDispatchCreator(
  runtime: KinguRuntimeService,
  callerHandle: string | undefined,
  callerSession: OrchestrationSessionCaller | undefined
): DispatchCreator {
  if (!callerHandle) {
    // No declared caller means no resolvable parent. Depth 0 is the same answer
    // the pre-existing Run-binding check already gives this case.
    return { kind: 'system' }
  }
  const caller = orchestrationCallerIdentity(runtime, {
    handle: callerHandle,
    session: callerSession,
    paneKey: null
  })
  if (caller.terminalHandle === null) {
    // A handle-less session: its Kingu session id is its whole identity.
    return caller.kinguSessionId
      ? { kind: 'session', kinguSessionId: caller.kinguSessionId }
      : { kind: 'system' }
  }
  const authority = runtime.getOrchestrationDispatchAuthority?.(caller.terminalHandle)
  return {
    kind: 'terminal',
    handle: caller.terminalHandle,
    paneKey:
      authority?.paneKey ??
      caller.paneKey ??
      runtime.getTerminalPaneKey(caller.terminalHandle) ??
      undefined,
    processIncarnation: authority?.processIncarnation ?? undefined,
    ...(caller.kinguSessionId ? { kinguSessionId: caller.kinguSessionId } : {})
  }
}
