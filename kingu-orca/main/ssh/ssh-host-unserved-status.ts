/** What a connect publishes when the managed server doesn't serve the host; there is no fallback. */
import type { SshManagedServerStatus } from '../../shared/ssh-types'
import type { HostServerOnConnectResult } from './ssh-host-server-on-connect'

type UnservedDecision = Extract<HostServerOnConnectResult, { route: 'unserved' }>

// Why `kind: 'relay'`: the published status keeps its shipped shape; it now means "not served".
export function unservedServerStatus(
  decision: UnservedDecision
): Extract<SshManagedServerStatus, { kind: 'relay' }> {
  return {
    kind: 'relay',
    reason: decision.reason,
    ...(decision.detail ? { detail: decision.detail } : {}),
    ...(decision.terminals !== undefined ? { terminals: decision.terminals } : {}),
    ...(decision.terminalsElsewhere ? { terminalsElsewhere: true } : {}),
    ...(decision.canLeaveBehind ? { canLeaveBehind: true } : {}),
    ...(decision.held ? { held: true } : {})
  }
}

const HELD_MOVE_MESSAGE =
  'Kingu paused moving this host’s projects to its managed server because it couldn’t confirm the server’s copy. Nothing is lost: the host keeps its projects and stays locked until the move finishes. Connect again to resume. If the server can’t come back, stop or forget it in Settings > Managed servers.'

/** Untranslated twin of the renderer's status line, for logs and callers without the catalog. */
export function unservedHostServerMessage(decision: UnservedDecision): string {
  if (decision.held && (decision.reason === 'failed' || decision.reason === 'deferred')) {
    return HELD_MOVE_MESSAGE
  }
  switch (decision.reason) {
    case 'kingud_unavailable':
      return 'This SSH host isn’t supported by this version of Kingu. To keep using it, install an older version of Kingu.'
    case 'relay_terminals_live':
    case 'relay_terminals_unverifiable':
      return 'Terminals started by an older version of Kingu are still running on this host, and they don’t stop on their own. Close them in that version of Kingu or end them on the host, then reconnect.'
    case 'refused':
      return decision.detail ?? 'Kingu couldn’t set up its server on this host.'
    case 'source_changed':
      return 'An older version of Kingu changed this host’s projects. Move those changes to its managed server in SSH Hosts settings to continue.'
    case 'deferred':
    case 'failed':
      return 'Kingu couldn’t start its server on this host. Try connecting again.'
  }
}
