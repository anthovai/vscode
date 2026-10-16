import { randomUUID } from 'node:crypto'
import { KINGUD_NODE_RUNTIME_IDENTITY } from '../../shared/kingud-node-runtime-identity'
import { KINGUD_NODE_RUNTIME_MARKER_FILENAME } from '../../shared/kingud-artifacts'
import {
  KINGUD_PROFILE_PREFLIGHT_FLAG,
  KINGUD_PROFILE_PREFLIGHT_TIMEOUT_MS,
  parseKingudProfilePreflight
} from '../../shared/kingud-profile-preflight'
import { assertPosixKingudHost } from './kingud-remote-host-support'
import {
  kingudWindowsNodeCommandLine,
  kingudWindowsSlotOpCommand,
  readKingudWindowsEncodedAnswer
} from './kingud-remote-windows-node'
import { readWindowsKingudSlotEntry } from './kingud-remote-launch-windows'
import { KINGUD_WINDOWS_RUNTIME_MARKER } from './kingud-windows-host-script'
import { kingudNodeSlotRuntimeCommand, selectKingudSlotEntryCommand } from './kingud-remote-runtime'
import { execCommand } from './ssh-relay-exec-command'
import { shellEscape } from './ssh-connection-utils'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import type { KingudHostTransport } from './kingud-host-transport'

export function kingudProfilePreflightCommand(
  host: RemoteHostPlatform,
  directory: string,
  nonce: string
): string {
  assertPosixKingudHost(host)
  // Why no host-Node fallback: a candidate this client installed is always a Node slot.
  const marker = shellEscape(joinRemotePath(host, directory, KINGUD_NODE_RUNTIME_MARKER_FILENAME))
  const launch = [
    'KINGU_BACKGROUND_LAUNCH=1',
    '"$kingud_runtime"',
    '"$kingud_entry"',
    KINGUD_PROFILE_PREFLIGHT_FLAG,
    shellEscape(nonce)
  ].join(' ')
  return `[ -e ${marker} ] || exit 78; ${kingudNodeSlotRuntimeCommand(host, directory)}${selectKingudSlotEntryCommand(host, directory)}; ${launch}`
}

/** Failure leaves the incumbent and its data untouched, including an unconfirmed SSH exit. */
export async function preflightInstalledKingud(options: {
  conn: KingudHostTransport
  host: RemoteHostPlatform
  remoteInstallDir: string
  fullVersion: string
  signal?: AbortSignal
}): Promise<void> {
  const nonce = randomUUID()
  const command = isWindowsRemoteHost(options.host)
    ? await windowsKingudProfilePreflightCommand(options, nonce)
    : kingudProfilePreflightCommand(options.host, options.remoteInstallDir, nonce)
  const output = await execCommand(options.conn, command, {
    signal: options.signal,
    timeoutMs: KINGUD_PROFILE_PREFLIGHT_TIMEOUT_MS,
    wrapCommand: !isWindowsRemoteHost(options.host)
  })
  parseKingudProfilePreflight(output, nonce, KINGUD_NODE_RUNTIME_IDENTITY, options.fullVersion)
}

/**
 * Windows: resolve the slot's node.exe, then run its selected entry with plain argv. No
 * KINGU_BACKGROUND_LAUNCH here: kingud opens no window, and argv cannot set environment.
 */
async function windowsKingudProfilePreflightCommand(
  options: {
    conn: KingudHostTransport
    host: RemoteHostPlatform
    remoteInstallDir: string
    signal?: AbortSignal
  },
  nonce: string
): Promise<string> {
  const { host, remoteInstallDir } = options
  const slotAnswer = await execCommand(
    options.conn,
    kingudWindowsSlotOpCommand(host, remoteInstallDir, 'slot-runtime', [remoteInstallDir]),
    { signal: options.signal, wrapCommand: false }
  )
  const runtime = readKingudWindowsEncodedAnswer(slotAnswer, KINGUD_WINDOWS_RUNTIME_MARKER)
  if (!runtime) {
    throw new Error('The Windows host did not name the runtime this kingud slot needs.')
  }
  return kingudWindowsNodeCommandLine(runtime, [
    readWindowsKingudSlotEntry(slotAnswer, host, remoteInstallDir),
    KINGUD_PROFILE_PREFLIGHT_FLAG,
    nonce
  ])
}
