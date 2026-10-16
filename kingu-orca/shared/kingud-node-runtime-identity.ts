import { NODE_RUNTIME_PIN } from './node-runtime-pin'
import type { KingudPreflightRuntimeIdentity } from './kingud-profile-preflight'

/** What a Node slot's candidate must report: the pinned runtime, never a host Node. */
export const KINGUD_NODE_RUNTIME_IDENTITY: KingudPreflightRuntimeIdentity = {
  runtime: 'node',
  runtimeVersion: NODE_RUNTIME_PIN.version
}
