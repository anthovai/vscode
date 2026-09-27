import {
  KINGUD_BUILD_TARGET_FILENAME,
  kingudBunRuntimeFilename
} from '../../shared/kingud-artifacts'
import { assertPosixKingudHost } from './kingud-remote-host-support'
import { shellEscape } from './ssh-connection-utils'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

/** Only legacy slots may use host Node; an incomplete Bun slot must not change runtimes. */
export function selectKingudSlotRuntimeCommand(
  host: RemoteHostPlatform,
  directory: string,
  legacyNodePath: string
): string {
  assertPosixKingudHost(host)
  const runtime = shellEscape(joinRemotePath(host, directory, kingudBunRuntimeFilename(host.os)))
  const target = shellEscape(joinRemotePath(host, directory, KINGUD_BUILD_TARGET_FILENAME))
  return (
    `if [ -e ${target} ] || [ -e ${runtime} ]; then ` +
    `[ -x ${runtime} ] || exit 78; kingud_runtime=${runtime}; ` +
    `else kingud_runtime=${shellEscape(legacyNodePath)}; fi`
  )
}
