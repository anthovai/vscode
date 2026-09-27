import { isKinguSessionId, type KinguSessionId } from './kingu-session-address'

/** A literal Kingu session id for a test, checked by the same predicate production uses. */
export function testKinguSessionId(id: string): KinguSessionId {
  if (!isKinguSessionId(id)) {
    throw new Error(`Not an Kingu session id: ${id}`)
  }
  return id
}
