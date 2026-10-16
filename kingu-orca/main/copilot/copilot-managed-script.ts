import {
  buildWindowsAgentHookPostCommand,
  getSharedManagedScriptPath
} from '../agent-hooks/installer-utils'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'

export function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'copilot-hook.cmd' : 'copilot-hook.sh'
}

export function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

export function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: Copilot consumes stdout for some hooks, so answer before any guard can exit.
      'echo {}',
      // Why: the direct registration passes the event as %1; the encoded fallback sets the env var.
      'if not "%~1"=="" set "KINGU_COPILOT_HOOK_EVENT=%~1"',
      // Why: refresh endpoint coordinates for PTYs surviving an Kingu restart.
      'if defined KINGU_AGENT_HOOK_ENDPOINT if exist "%KINGU_AGENT_HOOK_ENDPOINT%" call "%KINGU_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookPostCommand('copilot', [
        '  --data-urlencode "hookEventName=%KINGU_COPILOT_HOOK_EVENT%" ^'
      ]),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    "printf '{}\\n'",
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('copilot'),
    // Why: Copilot consumes stdout for some hooks, so stdout is emitted before
    // endpoint refresh, stdin parsing, or the network POST can fail.
    'if [ -n "$KINGU_AGENT_HOOK_ENDPOINT" ] && [ -r "$KINGU_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$KINGU_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$KINGU_AGENT_HOOK_PORT" ] || [ -z "$KINGU_AGENT_HOOK_TOKEN" ] || [ -z "$KINGU_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    // Why: pipe payload to curl's stdin (`payload@-`) instead of an inline
    // `payload=$VALUE` arg, so tens-of-KB tool output stays off the curl
    // command line (EDR command-line false positives). Wire body is identical.
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${KINGU_AGENT_HOOK_PORT}/hook/copilot" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Kingu-Agent-Hook-Token: ${KINGU_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${KINGU_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${KINGU_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${KINGU_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${KINGU_WORKTREE_ID}" \\',
    '  --data-urlencode "hookEventName=${KINGU_COPILOT_HOOK_EVENT}" \\',
    '  --data-urlencode "env=${KINGU_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${KINGU_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || spool_hook_event',
    'exit 0',
    ''
  ].join('\n')
}
