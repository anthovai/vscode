import type { KinguRuntimeService } from '../kingu-runtime'

export function routeDispatcherClientHostedBrowserRpc(
  runtime: KinguRuntimeService,
  method: string,
  params: unknown
) {
  const candidate = runtime as KinguRuntimeService & {
    routeClientHostedBrowserRpc?: KinguRuntimeService['routeClientHostedBrowserRpc']
  }
  return candidate.routeClientHostedBrowserRpc?.(method, params) ?? { handled: false as const }
}
