import type { KinguRuntimeService } from '../kingu-runtime'

export type WorkerTerminalReleaseRuntime = Pick<
  KinguRuntimeService,
  | 'retireStructuredAgentSessionTabFromSnapshot'
  | 'forgetStructuredSessionMail'
  | 'resolveOrchestrationWorkerServer'
  | 'callOrchestrationWorkerServer'
  | 'getOrchestrationFleetAgentStatusSnapshot'
  | 'getOrchestrationDb'
  | 'showTerminal'
  | 'resolveTerminalHandleByProcessIncarnation'
  | 'getTerminalPaneKey'
  | 'getTerminalProcessIncarnation'
  | 'getTerminalLivenessVerdict'
  | 'getOrchestrationDispatchAuthority'
  | 'ensureStructuredAgentSessionHost'
  | 'inspectTerminalProcessIncarnationLiveness'
  | 'closeTerminal'
  | 'getExactWorkerProviderSession'
  | 'readTerminal'
  | 'notifyMessageArrived'
>
