import type { SshTarget } from '../../shared/ssh-types'
import type { WslKingudHostTarget } from '../wsl/wsl-kingud-host-target'
import type { RemoteInstallTransport } from './remote-install-transport'
import type { KingudLaunchDetach } from './kingud-remote-launch'

/** The host an kingud transport reaches; only `id` and `label` mean the same for every kind. */
export type KingudHostTarget = SshTarget | WslKingudHostTarget

export function isWslKingudHostTarget(target: KingudHostTarget): target is WslKingudHostTarget {
  return 'kind' in target && target.kind === 'wsl'
}

/** The host connection kingud deploy, activation, serving and lifecycle code runs over. */
export type KingudHostTransport = RemoteInstallTransport & {
  /** Keys per-host state (remote context, wake dedupe) to the target it reaches. */
  getTarget(): KingudHostTarget
  /** How a launch leaves the exec's session; absent (SSH) means `nohup`. */
  readonly kingudLaunchDetach?: KingudLaunchDetach
  /** Host facts only the client can read, passed to kingud at launch; absent (SSH) adds none. */
  readonly kingudLaunchEnv?: () => Promise<readonly KingudLaunchEnvEntry[]>
}

export type KingudLaunchEnvEntry = readonly [name: string, value: string]
