import { randomUUID } from 'node:crypto'
import { KINGUD_BUN_VERSION } from '../../shared/kingud-bun-runtime'
import { kingudBunRuntimeFilename } from '../../shared/kingud-artifacts'
import {
  KINGUD_PROFILE_PREFLIGHT_FLAG,
  KINGUD_PROFILE_PREFLIGHT_TIMEOUT_MS,
  parseKingudProfilePreflight
} from '../../shared/kingud-profile-preflight'
import { assertPosixKingudHost } from './kingud-remote-host-support'
import { execCommand } from './ssh-relay-deploy-helpers'
import { shellEscape } from './ssh-connection-utils'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import type { SshConnection } from './ssh-connection'

export function kingudProfilePreflightCommand(
  host: RemoteHostPlatform,
  directory: string,
  nonce: string
): string {
  assertPosixKingudHost(host)
  return [
    'KINGU_BACKGROUND_LAUNCH=1',
    shellEscape(joinRemotePath(host, directory, kingudBunRuntimeFilename(host.os))),
    shellEscape(joinRemotePath(host, directory, 'kingud.js')),
    KINGUD_PROFILE_PREFLIGHT_FLAG,
    shellEscape(nonce)
  ].join(' ')
}

/** Failure leaves the incumbent and its data untouched, including an unconfirmed SSH exit. */
export async function preflightInstalledKingud(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteInstallDir: string
  fullVersion: string
  signal?: AbortSignal
}): Promise<void> {
  const nonce = randomUUID()
  const output = await execCommand(
    options.conn,
    kingudProfilePreflightCommand(options.host, options.remoteInstallDir, nonce),
    { signal: options.signal, timeoutMs: KINGUD_PROFILE_PREFLIGHT_TIMEOUT_MS }
  )
  parseKingudProfilePreflight(output, nonce, KINGUD_BUN_VERSION, options.fullVersion)
}
