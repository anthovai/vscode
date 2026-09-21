/**
 * kingud's garbage collection, and the half of §06 falsifier 1 that says who owns it.
 *
 * **Each model GCs only its own namespace, permanently.** kingud removes `kingud-<v>/`
 * directories; the relay removes `relay-<v>/` directories; neither ever removes the other's,
 * and no plan item makes one the winner. That is not a migration compromise — the two models
 * serve different users on the same machine (SSH target vs paired peer), so there is no
 * moment at which one of them is entitled to clean up after the other. A pass that deleted
 * the sibling's tree would be reaching across the execution boundary the whole design exists
 * to keep intact.
 *
 * On top of the ownership rule, kingud pins three directories that are idle-looking but
 * load-bearing: the active version, the rollback target, and whichever version the LIVE
 * terminal daemon was forked from.
 */
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { KINGUD_INSTALL_MODEL } from './remote-install-model'
import { gcOldRemoteInstallVersions } from './ssh-relay-versioned-install'
import { kingudGcPinnedDirNames, type KingudActivationRecord } from './kingud-activation-record'
import {
  kingudLivenessBlocksGc,
  kingudLivenessProbeCommand,
  parseKingudLiveness
} from './kingud-remote-launch'
import type { RemoteHostPlatform } from './ssh-remote-platform'

export type KingudGcOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  /** Absolute path of the version dir this client just used; never a candidate. */
  currentDirAbsPath: string
  record: KingudActivationRecord
  /**
   * The full version the live daemon's PID record names, when it can be read.
   *
   * An update preserves a daemon forked from the OUTGOING bundle whenever terminals are
   * live, so this is routinely a version that is neither active nor previous. Deleting it
   * would remove the tree under a running process.
   */
  liveDaemonVersion?: string | null
  signal?: AbortSignal
}

export async function gcOldKingudVersions(options: KingudGcOptions): Promise<void> {
  await gcOldRemoteInstallVersions(
    options.conn,
    KINGUD_INSTALL_MODEL,
    options.remoteHome,
    options.currentDirAbsPath,
    options.host,
    {
      pinnedDirNames: kingudGcPinnedDirNames(options.record, options.liveDaemonVersion),
      isDirLive: async (dir) => {
        try {
          const probe = await execCommand(
            options.conn,
            kingudLivenessProbeCommand(options.host, dir),
            {
              wrapCommand: options.host.commandDialect !== 'powershell',
              signal: options.signal
            }
          )
          return kingudLivenessBlocksGc(parseKingudLiveness(probe))
        } catch {
          // Why true: an unanswered probe is not evidence a tree is idle. Same rule the
          // relay's socket probe applies, for the same reason.
          return true
        }
      }
    }
  )
}
