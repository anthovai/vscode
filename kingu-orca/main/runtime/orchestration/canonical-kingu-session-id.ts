import type { KinguSessionId } from '../../../shared/kingu-session-address'

/** The Kingu session id orchestration addresses a session by; every session-to-party step calls this. */
export function canonicalKinguSessionId(kinguSessionId: KinguSessionId): KinguSessionId {
  // Later lineage canonicalization (a `/clear`ed session to its lineage root) plugs in here.
  return kinguSessionId
}
