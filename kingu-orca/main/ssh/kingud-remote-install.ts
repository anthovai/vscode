import { kingudBunRuntimeFilename } from '../../shared/kingud-artifacts'
import { kingudAgentBrowserNativeName } from '../../shared/kingud-agent-browser-name'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import { shellEscape } from './ssh-connection-utils'
import type { SshConnection } from './ssh-connection'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { KINGUD_INSTALL_MODEL } from './remote-install-model'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { uploadRelayDirectory, writeRelayFile } from './ssh-relay-install-transfers'
import {
  abandonInstall,
  finalizeInstall,
  isRemoteInstallComplete
} from './ssh-relay-versioned-install'

/** Install the bytes under `kingud-<version>/`, using the relay's install transaction. */
export async function installKingudBundle(
  options: {
    conn: SshConnection
    host: RemoteHostPlatform
    localKingudDir: string
    signal?: AbortSignal
  },
  fullVersion: string,
  remoteDir: string
): Promise<void> {
  if (
    await isRemoteInstallComplete(options.conn, KINGUD_INSTALL_MODEL, remoteDir, options.host, {
      signal: options.signal
    })
  ) {
    return
  }
  await acquireInstallLock(options.conn, remoteDir, options.host, { signal: options.signal })
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
      await execCommand(options.conn, executablePermissionsCommand(options.host, remoteDir), {
        wrapCommand: options.host.commandDialect !== 'powershell',
        signal: options.signal
      })
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
      await abandonInstall(options.conn, remoteDir, options.host)
    }
  }
}

function executablePermissionsCommand(host: RemoteHostPlatform, directory: string): string {
  const required = [
    joinRemotePath(host, directory, kingudBunRuntimeFilename(host.os)),
    joinRemotePath(host, directory, 'ripgrep', host.relayPlatform, 'rg')
  ]
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
