import {
  parseKinguSessionAddress,
  type KinguSessionId
} from '../../../shared/kingu-session-address'
import { structuredWorkerKinguSessionIdForIncarnation } from '../structured-worker-identity'
import { canonicalKinguSessionId } from './canonical-kingu-session-id'

/**
 * The Kingu session id a Dispatch row stores for its assignee: the structured worker its process
 * incarnation names, or the chat its `kingu_session_id:` handle names. A PTY has none.
 */
export function dispatchAssigneeKinguSessionId(assignee: {
  handle: string
  processIncarnation: string | null | undefined
}): KinguSessionId | null {
  const kinguSessionId =
    structuredWorkerKinguSessionIdForIncarnation(assignee.processIncarnation) ??
    parseKinguSessionAddress(assignee.handle)
  return kinguSessionId === null ? null : canonicalKinguSessionId(kinguSessionId)
}
