/** The installed entry bytes, hashed as the server reports them for activation and rollback. */
import { KINGUD_LAUNCHER_FILENAME } from '../../shared/kingud-artifacts'
import { shellEscape } from './ssh-connection-utils'
import { execKingudRemote, type KingudRemoteExecTarget } from './kingud-remote-runtime-control'
import { kingudWindowsSlotOpCommand } from './kingud-remote-windows-node'
import { KINGUD_BUILD_HASH_MARKER as BUILD_HASH_MARKER } from './kingud-windows-host-script'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

export async function readRemoteKingudBuildHash(
  target: KingudRemoteExecTarget,
  remoteInstallDir: string
): Promise<string> {
  const output = await execKingudRemote(
    target,
    remoteKingudBuildHashCommand(target.host, remoteInstallDir)
  )
  const match = output.match(new RegExp(`${BUILD_HASH_MARKER}\\s+([a-fA-F0-9]{16})`, 'u'))
  if (!match?.[1]) {
    throw new Error('Could not verify the installed kingud build hash.')
  }
  return match[1].toLowerCase()
}

export function remoteKingudBuildHashCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  if (isWindowsRemoteHost(host)) {
    return kingudWindowsSlotOpCommand(host, remoteInstallDir, 'build-hash', [
      joinRemotePath(host, remoteInstallDir, KINGUD_LAUNCHER_FILENAME)
    ])
  }
  const path = shellEscape(joinRemotePath(host, remoteInstallDir, KINGUD_LAUNCHER_FILENAME))
  // Why both tools: GNU/busybox ship sha256sum, macOS ships shasum; either prints the digest first.
  return [
    `[ -f ${path} ] && [ -r ${path} ] || exit 1;`,
    `kingu_hash=$(if command -v sha256sum >/dev/null 2>&1; then sha256sum ${path} | awk '{print $1}';`,
    `elif command -v shasum >/dev/null 2>&1; then shasum -a 256 ${path} | awk '{print $1}'; fi);`,
    `case "$kingu_hash" in [0-9a-fA-F][0-9a-fA-F]*) printf '%s %.16s\\n' ${shellEscape(BUILD_HASH_MARKER)} "$kingu_hash";; esac`
  ].join(' ')
}
