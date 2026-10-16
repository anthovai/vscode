import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { resolveKingudDeploymentTargetFacts } from './kingud-deployment-target'
import { KingudHostUnsupportedError } from '../kingud/kingud-host-unavailable'
import type { KingudHostTransport } from './kingud-host-transport'
import { pinnedRuntimeTargetForHost } from './pinned-runtime-host-target'
import type { RemoteHostPlatform } from './ssh-remote-platform'

/**
 * The runtime target managed kingud deploys on a host, picked by glibc: the host's own target, or
 * its compat runtime below the default's glibc floor.
 */
export async function resolveKingudRuntimeTarget(options: {
  conn: KingudHostTransport
  host: RemoteHostPlatform
  signal?: AbortSignal
  exec?: (command: string) => Promise<string>
}): Promise<NodeRuntimeTarget> {
  const facts = await resolveKingudDeploymentTargetFacts(options)
  const target = pinnedRuntimeTargetForHost(facts)
  if (!target) {
    const glibc = facts.glibc ? `${facts.glibc.major}.${facts.glibc.minor}` : 'unknown'
    throw new KingudHostUnsupportedError(
      `No Kingu runtime supports ${facts.target} with glibc ${glibc}.`
    )
  }
  return target
}
