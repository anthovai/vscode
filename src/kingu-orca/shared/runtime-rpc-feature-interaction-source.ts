export const KINGU_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY = '__kinguFeatureInteractionSource'

export const KINGU_RUNTIME_RPC_BROWSER_UI_SOURCE = 'browser-pane-ui'

export function withBrowserPaneUiRuntimeRpcSource(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      [KINGU_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY]: KINGU_RUNTIME_RPC_BROWSER_UI_SOURCE
    }
  }
  return {
    ...value,
    [KINGU_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY]: KINGU_RUNTIME_RPC_BROWSER_UI_SOURCE
  }
}

export function isBrowserPaneUiRuntimeRpcParams(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[KINGU_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY] ===
      KINGU_RUNTIME_RPC_BROWSER_UI_SOURCE
  )
}
