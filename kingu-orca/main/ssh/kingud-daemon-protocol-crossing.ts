/**
 * D7: whether live terminals survive an kingud restart onto another build.
 *
 * The daemon outlives every kingud restart, so after the swap the incoming build must route
 * sessions owned by a daemon that may speak another protocol. It can only when it speaks that
 * protocol or lists it as previous — the same rule `config/scripts/daemon-protocol-facts.mjs`
 * (`canAttach`) applies to release pairs in CI.
 */
import {
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION
} from '../daemon/daemon-protocol-version'
import type { KingudTerminalCensus } from './kingud-update-plan'

export type KingudDaemonProtocolFacts = {
  protocolVersion: number
  previousProtocolVersions: readonly number[]
}

/** This client's build, which is also the kingud bundle it deploys. */
export const CURRENT_KINGUD_DAEMON_PROTOCOL: KingudDaemonProtocolFacts = {
  protocolVersion: PROTOCOL_VERSION,
  previousProtocolVersions: PREVIOUS_DAEMON_PROTOCOL_VERSIONS
}

export function kingudBuildCanAttachDaemon(
  reader: KingudDaemonProtocolFacts,
  ownerProtocolVersion: number
): boolean {
  return (
    reader.protocolVersion === ownerProtocolVersion ||
    reader.previousProtocolVersions.includes(ownerProtocolVersion)
  )
}

export type KingudLiveDaemonCrossing =
  | 'no-live-terminals'
  | 'attachable'
  | 'strands-live-terminals'
  | 'unverifiable'

/** An unknown session count or daemon protocol is planned for as live and unattachable. */
export function assessKingudLiveDaemonCrossing(
  census: KingudTerminalCensus,
  incoming: KingudDaemonProtocolFacts
): KingudLiveDaemonCrossing {
  if (census.liveSessions === 0) {
    return 'no-live-terminals'
  }
  if (census.daemonProtocolVersion === null) {
    return 'unverifiable'
  }
  return kingudBuildCanAttachDaemon(incoming, census.daemonProtocolVersion)
    ? 'attachable'
    : 'strands-live-terminals'
}
