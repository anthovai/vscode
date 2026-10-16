/**
 * Which paired runtime environments are a WSL distro's kingud, so desktop-side shims (accounts)
 * know the distro behind an environment id. Fed by `WslKingudConnectionManager`: an environment is
 * listed only while its connection is open.
 */
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

const distrosByEnvironment = new Map<string, string>()
/** The capabilities the connected kingud last reported; dropped on every (re)connect. */
const capabilitiesByEnvironment = new Map<string, readonly string[]>()

export function registerWslKingudHostEnvironment(environmentId: string, distro: string): void {
  distrosByEnvironment.set(environmentId, distro)
  // Why: a reconnect may be a redeployed kingud, whose capabilities differ.
  capabilitiesByEnvironment.delete(environmentId)
}

export function unregisterWslKingudHostEnvironment(environmentId: string, distro: string): void {
  if (distrosByEnvironment.get(environmentId) === distro) {
    distrosByEnvironment.delete(environmentId)
    capabilitiesByEnvironment.delete(environmentId)
  }
}

export function wslKingudHostDistro(environmentId: string): string | null {
  return distrosByEnvironment.get(environmentId) ?? null
}

type WslKingudHostEnvironmentRef = { environmentId: string; distro: string }

/** Lists `next` while open; a closed connection (`next` null) unlists `previous`. */
export function trackWslKingudHostEnvironment(
  previous: WslKingudHostEnvironmentRef,
  next: WslKingudHostEnvironmentRef | null
): void {
  if (next) {
    registerWslKingudHostEnvironment(next.environmentId, next.distro)
  } else {
    unregisterWslKingudHostEnvironment(previous.environmentId, previous.distro)
  }
}

function capabilitiesOf(result: unknown): readonly string[] | null {
  if (typeof result !== 'object' || result === null || !('capabilities' in result)) {
    return null
  }
  const { capabilities } = result
  return Array.isArray(capabilities)
    ? capabilities.filter((entry): entry is string => typeof entry === 'string')
    : null
}

/** Records a WSL kingud's capabilities from any `status.get` answer that passes the desktop. */
export function observeWslKingudHostResponse(
  environmentId: string,
  method: string,
  response: RuntimeRpcResponse<unknown>
): void {
  if (method !== 'status.get' || !response.ok || !distrosByEnvironment.has(environmentId)) {
    return
  }
  const capabilities = capabilitiesOf(response.result)
  if (capabilities) {
    capabilitiesByEnvironment.set(environmentId, capabilities)
  }
}

export type WslKingudHostCapabilityVerdict = 'supported' | 'unsupported' | 'unknown'

/** Whether the WSL kingud behind `environmentId` advertises `capability`; asks it once when no
 *  answer has been seen. A failed probe is `unknown`, never evidence of an older host. */
export async function wslKingudHostSupports(
  environmentId: string,
  capability: string,
  readStatus: () => Promise<RuntimeRpcResponse<unknown>>
): Promise<WslKingudHostCapabilityVerdict> {
  if (!capabilitiesByEnvironment.has(environmentId)) {
    try {
      observeWslKingudHostResponse(environmentId, 'status.get', await readStatus())
    } catch {
      return 'unknown'
    }
  }
  const capabilities = capabilitiesByEnvironment.get(environmentId)
  if (!capabilities) {
    return 'unknown'
  }
  return capabilities.includes(capability) ? 'supported' : 'unsupported'
}
