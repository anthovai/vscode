import { randomUUID } from 'node:crypto'
import { kingudNodePtyNativeArtifacts, kingudRipgrepArtifact } from '../../shared/kingud-artifacts'
import { kingudAgentBrowserNativeName } from '../../shared/kingud-agent-browser-name'
import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { ensureRemoteKingudNodeRuntime } from './kingud-remote-node-runtime'
import { recordedRemoteNodeRuntimeProbeCommand } from './kingud-remote-node-runtime-recorded-probe'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import { shellEscape } from './ssh-connection-utils'
import type { KingudHostTransport } from './kingud-host-transport'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { KINGUD_INSTALL_MODEL } from './remote-install-model'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { KINGUD_FENCE_OWNER_FILENAME } from './kingud-activation-fence-scope'
import { forgetHeldKingudFence, rememberHeldKingudFence } from './kingud-held-fence-tokens'
import { exitedOwnLockProof } from './kingud-exited-own-lock'
import { kingudWindowsBaseDir } from './kingud-remote-windows-node'
import { uploadRelayDirectory, writeRelayFile } from './ssh-relay-install-transfers'
import {
  abandonInstall,
  finalizeInstall,
  isRemoteInstallComplete
} from './remote-versioned-install'

/** Install the bytes under `kingud-<version>/`, using the relay's install transaction. */
export async function installKingudBundle(
  options: {
    conn: KingudHostTransport
    host: RemoteHostPlatform
    localKingudDir: string
    target: NodeRuntimeTarget
    /** The locally verified pinned Node archive, fetched only when the host lacks the runtime. */
    nodeRuntimeArchive: () => Promise<string>
    /** WSL only: skip re-hashing a runtime whose stat signature is unchanged since it hashed to the pin. */
    recordedNodeRuntimeProbe?: boolean
    signal?: AbortSignal
  },
  fullVersion: string,
  remoteDir: string
): Promise<void> {
  // Why before the slot probe: an installed slot is unlaunchable without the runtime it names.
  await ensureRemoteKingudNodeRuntime({
    conn: options.conn,
    host: options.host,
    slotDir: remoteDir,
    target: options.target,
    archivePath: options.nodeRuntimeArchive,
    signal: options.signal,
    ...(options.recordedNodeRuntimeProbe
      ? { posixProbeCommand: recordedRemoteNodeRuntimeProbeCommand }
      : {})
  })
  if (
    await isRemoteInstallComplete(options.conn, KINGUD_INSTALL_MODEL, remoteDir, options.host, {
      signal: options.signal
    })
  ) {
    return
  }
  // Its token lets a relaunch prove a lock its own quit left mid-upload (BUG-23).
  const token = randomUUID()
  rememberHeldKingudFence(token)
  try {
    await acquireInstallLock(options.conn, remoteDir, options.host, {
      signal: options.signal,
      owner: { fileName: KINGUD_FENCE_OWNER_FILENAME, token },
      // Nothing keeps writing once its client exited: uploads are SFTP and chmod is immediate.
      exitedOwner: exitedOwnLockProof(options, {
        baseDir: kingudWindowsBaseDir(options.host, remoteDir),
        guardsStateMutation: false
      })
    })
  } catch (error) {
    if (!isUnconfirmedSshCommandTermination(error)) {
      forgetHeldKingudFence(token)
    }
    throw error
  }
  let preserveInstallLock = false
  try {
    // Re-probe under the lock: a sibling deploy may have finished while we waited.
    if (
      await isRemoteInstallComplete(options.conn, KINGUD_INSTALL_MODEL, remoteDir, options.host, {
        signal: options.signal
      })
    ) {
      return
    }
    await uploadRelayDirectory(options.conn, options.localKingudDir, remoteDir, options.host, {
      signal: options.signal
    })
    if (options.host.os !== 'win32') {
      await execCommand(
        options.conn,
        executablePermissionsCommand(options.host, remoteDir, options.target),
        {
          wrapCommand: options.host.commandDialect !== 'powershell',
          signal: options.signal
        }
      )
    }
    await writeRelayFile(
      options.conn,
      options.host,
      joinRemotePath(options.host, remoteDir, KINGUD_INSTALL_MODEL.versionFilename),
      fullVersion,
      { signal: options.signal }
    )
    await finalizeInstall(options.conn, remoteDir, options.host, {
      signal: options.signal,
      releaseLock: false
    })
  } catch (error) {
    preserveInstallLock = isUnconfirmedSshCommandTermination(error)
    throw error
  } finally {
    if (!preserveInstallLock) {
      // A removal a quit cut short keeps the token, so the relaunch can prove the lock its own.
      if (await abandonInstall(options.conn, remoteDir, options.host)) {
        forgetHeldKingudFence(token)
      }
    }
  }
}

function executablePermissionsCommand(
  host: RemoteHostPlatform,
  directory: string,
  target: NodeRuntimeTarget
): string {
  const required = [kingudRipgrepArtifact(target), ...kingudNodePtyNativeArtifacts(target)]
    .filter((artifact) => /\/(?:rg|spawn-helper)$/.test(artifact))
    .map((artifact) => joinRemotePath(host, directory, ...artifact.split('/')))
  const browsers = new Set(
    (['glibc', 'musl'] as const).map((libc) =>
      shellEscape(
        joinRemotePath(host, directory, kingudAgentBrowserNativeName(host.os, host.arch, libc))
      )
    )
  )
  // SFTP drops executable modes; missing optional browser binaries remain a supported install.
  return (
    `chmod 755 ${required.map(shellEscape).join(' ')} && ` +
    `for executable in ${[...browsers].join(' ')}; do ` +
    'if [ -f "$executable" ]; then chmod 755 "$executable" || exit $?; fi; done'
  )
}
