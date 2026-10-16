/**
 * What every managed-kingud operation on a Windows host needs before its first host op: this
 * client's pinned node.exe in the runtime store, and the host script it runs.
 *
 * Both are idempotent: a present runtime costs one probe and nothing is uploaded, and the host
 * script is content-addressed, so rewriting it changes nothing a running kingud depends on.
 */
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { ensureRemoteKingudNodeRuntime } from './kingud-remote-node-runtime'
import { installKingudWindowsHostScript, kingudRemoteBaseDir } from './kingud-remote-windows-node'
import { materializeNodeRuntimeArchive } from '../node-runtime/pinned-runtime-materializer'
import type { KingudHostTransport } from './kingud-host-transport'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

export async function prepareWindowsKingudHost(options: {
  conn: KingudHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  serverTarget: NodeRuntimeTarget
  signal?: AbortSignal
}): Promise<void> {
  const baseDir = kingudRemoteBaseDir(options.host, options.remoteHome)
  await ensureRemoteKingudNodeRuntime({
    conn: options.conn,
    host: options.host,
    // Only its parent is read: the runtime store sits beside the slots.
    slotDir: joinRemotePath(options.host, baseDir, 'kingud-host'),
    target: options.serverTarget,
    archivePath: () =>
      materializeNodeRuntimeArchive(
        options.serverTarget,
        join(getAppEnvironment().getPath('userData'), 'kingud-artifacts'),
        { signal: options.signal }
      ),
    signal: options.signal
  })
  await installKingudWindowsHostScript(options, baseDir)
}
