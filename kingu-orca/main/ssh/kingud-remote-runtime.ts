import {
  KINGUD_BUILD_TARGET_FILENAME,
  KINGUD_LAUNCHER_FILENAME,
  KINGUD_SERVER_ENTRY_FILENAME,
  KINGUD_NODE_RUNTIME_DIR_PREFIX,
  KINGUD_NODE_RUNTIME_MARKER_FILENAME,
  KINGUD_NODE_RUNTIME_POSIX_EXECUTABLE,
  KINGUD_RUNTIMES_DIRNAME,
  kingudBunRuntimeFilename
} from '../../shared/kingud-artifacts'
import { assertPosixKingudHost } from './kingud-remote-host-support'
import { shellEscape } from './ssh-connection-utils'
import { joinRemotePath, remoteDirname, type RemoteHostPlatform } from './ssh-remote-platform'

/** New slots start the server directly; rollback still accepts older single-entry slots. */
export function selectKingudSlotEntryCommand(host: RemoteHostPlatform, directory: string): string {
  assertPosixKingudHost(host)
  const server = shellEscape(joinRemotePath(host, directory, KINGUD_SERVER_ENTRY_FILENAME))
  const launcher = shellEscape(joinRemotePath(host, directory, KINGUD_LAUNCHER_FILENAME))
  return `if [ -f ${server} ]; then kingud_entry=${server}; else kingud_entry=${launcher}; fi`
}

/**
 * Sets `$kingud_runtime` to the pinned Node a slot's `.runtime-node` names, or exits 78.
 * Assumes the marker exists; callers decide what its absence means.
 */
export function kingudNodeSlotRuntimeCommand(host: RemoteHostPlatform, directory: string): string {
  assertPosixKingudHost(host)
  const nodeMarker = shellEscape(
    joinRemotePath(host, directory, KINGUD_NODE_RUNTIME_MARKER_FILENAME)
  )
  const nodeRuntimePrefix = shellEscape(
    joinRemotePath(
      host,
      remoteDirname(directory.replace(/\/+$/, ''), host),
      KINGUD_RUNTIMES_DIRNAME,
      KINGUD_NODE_RUNTIME_DIR_PREFIX
    )
  )
  const nodeExecutable = shellEscape(`/${KINGUD_NODE_RUNTIME_POSIX_EXECUTABLE}`)
  return (
    `kingud_node_sha=$(cat ${nodeMarker}) || exit 78; ` +
    // Why validate: the digest becomes a path segment, so only a bare sha256 may reach it.
    // The leading `(` keeps the pattern parseable when stop embeds this in `$(...)`.
    'case "$kingud_node_sha" in ("" | *[!0-9a-f]*) exit 78;; esac; ' +
    '[ "${#kingud_node_sha}" -eq 64 ] || exit 78; ' +
    `kingud_runtime=${nodeRuntimePrefix}"$kingud_node_sha"${nodeExecutable}; ` +
    '[ -x "$kingud_runtime" ] || exit 78; '
  )
}

/**
 * The slot's own contents pick its runtime: Node marker, then Bun, then legacy host Node.
 * Only legacy slots may use host Node; an incomplete Node or Bun slot must not change runtimes.
 */
export function selectKingudSlotRuntimeCommand(
  host: RemoteHostPlatform,
  directory: string,
  legacyNodePath: string
): string {
  assertPosixKingudHost(host)
  const nodeMarker = shellEscape(
    joinRemotePath(host, directory, KINGUD_NODE_RUNTIME_MARKER_FILENAME)
  )
  const runtime = shellEscape(joinRemotePath(host, directory, kingudBunRuntimeFilename(host.os)))
  const target = shellEscape(joinRemotePath(host, directory, KINGUD_BUILD_TARGET_FILENAME))
  return (
    `if [ -e ${nodeMarker} ]; then ${kingudNodeSlotRuntimeCommand(host, directory)}` +
    `elif [ -e ${target} ] || [ -e ${runtime} ]; then ` +
    `[ -x ${runtime} ] || exit 78; kingud_runtime=${runtime}; ` +
    `else kingud_runtime=${shellEscape(legacyNodePath)}; fi`
  )
}
