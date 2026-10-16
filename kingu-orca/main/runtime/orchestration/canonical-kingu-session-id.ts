import { isKinguSessionId, type KinguSessionId } from '../../../shared/kingu-session-address'
import {
  clearedInto,
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from './structured-session-lineage'

/**
 * The Kingu session id orchestration addresses a session by: the first session of its `/clear`
 * lineage, so a cleared chat keeps the address, Runs and mail it had. Every session-to-party step
 * calls this. Without a record store there is no lineage to read, and the id stands for itself.
 */
export function canonicalKinguSessionId(
  kinguSessionId: KinguSessionId,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): KinguSessionId {
  if (!store) {
    return kinguSessionId
  }
  const clearedFrom = new Map<string, string>()
  for (const record of store.listRecords()) {
    const next = clearedInto(record)
    if (next) {
      clearedFrom.set(next, record.sessionId)
    }
  }
  // A clear chain is acyclic by construction; the visited set only bounds a corrupt store.
  let root: string = kinguSessionId
  const earlier = new Set([root])
  let prior = clearedFrom.get(root)
  while (prior && !earlier.has(prior)) {
    earlier.add(prior)
    root = prior
    prior = clearedFrom.get(root)
  }
  // Record ids are minted as Kingu session ids; one that is not cannot name the conversation.
  return isKinguSessionId(root) ? root : kinguSessionId
}
