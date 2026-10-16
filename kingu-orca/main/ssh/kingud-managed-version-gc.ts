/**
 * After a managed deploy or update, removes this host's older kingud version dirs that are
 * proven stopped (design D10). Pins come from gcOldKingudVersions: the active version, the
 * rollback target, journaled versions, and the version the live terminal daemon was forked
 * from. Anything the host cannot answer about is kept.
 */
import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import type { ServeReadiness } from '../server/serve-readiness'
import { readKingudActivationRecord } from './kingud-activation-record-store'
import { kingudSlotDir, type KingudSlotOptions } from './kingud-recovery-slot'
import { gcOldKingudVersions } from './kingud-remote-gc'
import { nodeRuntimeStorePins } from './pinned-runtime-host-target'

/** The daemon's build when the readiness proves it; undefined when it cannot say. */
export function provenLiveDaemonVersion(readiness: ServeReadiness): string | null | undefined {
  const daemon = readiness.health?.terminalDaemon
  if (daemon?.state === 'live' && daemon.buildVersion) {
    return daemon.buildVersion
  }
  // A daemon that answered as absent forked from nothing; degraded or unreported proves nothing.
  return daemon?.state === 'absent' ? null : undefined
}

export async function pruneManagedKingudVersions(args: {
  slot: KingudSlotOptions
  serverTarget: NodeRuntimeTarget
  activeVersion: string
  readiness: ServeReadiness
}): Promise<void> {
  const liveDaemonVersion = provenLiveDaemonVersion(args.readiness)
  // Why skip: without the daemon's version, GC could remove the tree a live daemon runs from.
  if (liveDaemonVersion === undefined) {
    return
  }
  try {
    await gcOldKingudVersions({
      conn: args.slot.conn,
      host: args.slot.host,
      remoteHome: args.slot.remoteHome,
      currentDirAbsPath: kingudSlotDir(args.slot, args.activeVersion),
      record: await readKingudActivationRecord(args.slot),
      liveDaemonVersion,
      // Why both pins: a default and a compat kingud on one host share one runtime store.
      nodeRuntimePins: nodeRuntimeStorePins(args.serverTarget),
      signal: args.slot.signal
    })
  } catch (error) {
    // Best effort: the deploy already succeeded, and the next connect tries again.
    console.warn('[kingud-gc] Pruning old kingud versions failed:', error)
  }
}
