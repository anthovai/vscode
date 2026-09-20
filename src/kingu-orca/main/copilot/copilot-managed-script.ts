import { getSharedManagedScriptPath } from '../agent-hooks/installer-utils'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD
} from '../agent-hooks/hook-stdin-contract'

export function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'copilot-hook.ps1' : 'copilot-hook.sh'
}

export function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

export function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      "Write-Output '{}'",
      // Why: endpoint.cmd is cmd syntax, not PowerShell. Parse its `set KEY=...`
      // lines so surviving PTYs can refresh to the current Kingu server.
      'if ($env:KINGU_AGENT_HOOK_ENDPOINT -and (Test-Path -LiteralPath $env:KINGU_AGENT_HOOK_ENDPOINT)) {',
      '  try {',
      '    Get-Content -LiteralPath $env:KINGU_AGENT_HOOK_ENDPOINT | ForEach-Object {',
      "      if ($_ -match '^set ([A-Za-z0-9_]+)=(.*)$') {",
      "        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')",
      '      }',
      '    }',
      '  } catch {}',
      '}',
      // Why (#11549 class): missing Kingu context means a user-wide hook fired outside an
      // Kingu pane. ReadToEnd blocks forever if that caller abandons the pipe, so the guard
      // must run before the hook owns stdin; the payload would be discarded anyway.
      WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD,
      '$inputData = [Console]::In.ReadToEnd()',
      'if ([string]::IsNullOrWhiteSpace($inputData)) { exit 0 }',
      'try {',
      '  $payload = $inputData | ConvertFrom-Json',
      '  $body = @{',
      '    paneKey = $env:KINGU_PANE_KEY',
      '    launchToken = $env:KINGU_AGENT_LAUNCH_TOKEN',
      '    tabId = $env:KINGU_TAB_ID',
      '    worktreeId = $env:KINGU_WORKTREE_ID',
      '    hookEventName = $env:KINGU_COPILOT_HOOK_EVENT',
      '    env = $env:KINGU_AGENT_HOOK_ENV',
      '    version = $env:KINGU_AGENT_HOOK_VERSION',
      '    payload = $payload',
      '  } | ConvertTo-Json -Depth 100',
      "  Invoke-WebRequest -UseBasicParsing -Method Post -Uri ('http://127.0.0.1:' + $env:KINGU_AGENT_HOOK_PORT + '/hook/copilot') -Headers @{ 'Content-Type'='application/json'; 'X-Kingu-Agent-Hook-Token'=$env:KINGU_AGENT_HOOK_TOKEN } -Body $body -TimeoutSec 2 | Out-Null",
      '} catch {}',
      'exit 0',
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
