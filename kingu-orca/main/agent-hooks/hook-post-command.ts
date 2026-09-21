import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { KINGU_HOOK_RAW_JSON_TRANSPORT } from '../../shared/agent-hook-types'

export function buildPosixAgentHookPostCommand(
  source: AgentHookSource,
  options: { curlCommand?: string; indent?: string } = {}
): string[] {
  const curlCommand = options.curlCommand ?? 'curl'
  const indent = options.indent ?? '  '
  return [
    `if [ "\${KINGU_AGENT_HOOK_TRANSPORT:-}" = "${KINGU_HOOK_RAW_JSON_TRANSPORT}" ] && command -v base64 >/dev/null 2>&1 && command -v tr >/dev/null 2>&1; then`,
    `  kingu_hook_metadata=$(printf '%s\\037%s\\037%s\\037%s\\037%s\\037%s' "$KINGU_PANE_KEY" "$KINGU_TAB_ID" "$KINGU_AGENT_LAUNCH_TOKEN" "$KINGU_WORKTREE_ID" "$KINGU_AGENT_HOOK_ENV" "$KINGU_AGENT_HOOK_VERSION" | base64 | tr -d '\\n') && \\`,
    `  [ -n "$kingu_hook_metadata" ] && \\`,
    `  printf '%s' "$payload" | ${curlCommand} -sS -X POST "http://127.0.0.1:\${KINGU_AGENT_HOOK_PORT}/hook/${source}" \\`,
    `  ${indent}--connect-timeout "\${connect_timeout:-0.5}" --max-time "\${max_time:-1.5}" \\`,
    `  ${indent}--noproxy "127.0.0.1" \\`,
    `  ${indent}-H "Content-Type: application/json" \\`,
    `  ${indent}-H "X-Kingu-Agent-Hook-Token: \${KINGU_AGENT_HOOK_TOKEN}" \\`,
    `  ${indent}-H "X-Kingu-Agent-Hook-Meta-Encoding: base64" \\`,
    `  ${indent}-H "X-Kingu-Agent-Hook-Meta: \${kingu_hook_metadata}" \\`,
    `  ${indent}--data-binary @-`,
    'else',
    `  printf '%s' "$payload" | ${curlCommand} -sS -X POST "http://127.0.0.1:\${KINGU_AGENT_HOOK_PORT}/hook/${source}" \\`,
    `  ${indent}--connect-timeout "\${connect_timeout:-0.5}" --max-time "\${max_time:-1.5}" \\`,
    `  ${indent}--noproxy "127.0.0.1" \\`,
    `  ${indent}-H "Content-Type: application/x-www-form-urlencoded" \\`,
    `  ${indent}-H "X-Kingu-Agent-Hook-Token: \${KINGU_AGENT_HOOK_TOKEN}" \\`,
    `  ${indent}--data-urlencode "paneKey=\${KINGU_PANE_KEY}" \\`,
    `  ${indent}--data-urlencode "tabId=\${KINGU_TAB_ID}" \\`,
    `  ${indent}--data-urlencode "launchToken=\${KINGU_AGENT_LAUNCH_TOKEN}" \\`,
    `  ${indent}--data-urlencode "worktreeId=\${KINGU_WORKTREE_ID}" \\`,
    `  ${indent}--data-urlencode "env=\${KINGU_AGENT_HOOK_ENV}" \\`,
    `  ${indent}--data-urlencode "version=\${KINGU_AGENT_HOOK_VERSION}" \\`,
    `  ${indent}--data-urlencode "payload@-"`,
    'fi'
  ]
}
