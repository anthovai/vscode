/** Capture before Kingu inserts its managed-script shell. */
export const CLAUDE_HOOK_PARENT_CAPTURE =
  'KINGU_HOOK_AGENT_PID="${PPID:-}"; export KINGU_HOOK_AGENT_PID; '

export function buildHookProcessCapture(): string[] {
  return [
    'kingu_agent_process=',
    // Why: skip the process reads for Claude sessions outside an Kingu pane.
    '[ -z "${KINGU_PANE_KEY:-}" ] || case "${KINGU_HOOK_AGENT_PID:-}" in ""|*[!0-9]*) ;; *)',
    '  if [ -r "/proc/$KINGU_HOOK_AGENT_PID/stat" ]; then',
    '    kingu_agent_stat=$(cat "/proc/$KINGU_HOOK_AGENT_PID/stat" 2>/dev/null) || kingu_agent_stat=',
    '    kingu_agent_boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || kingu_agent_boot=',
    '    kingu_agent_fields=${kingu_agent_stat##*) }',
    '    kingu_agent_start=$(printf "%s" "$kingu_agent_fields" | awk \'{print $20}\')',
    '    case "$kingu_agent_start" in ""|*[!0-9]*) ;; *)',
    '      [ -z "$kingu_agent_boot" ] || kingu_agent_process=$(printf \'{"pid":%s,"platform":"linux","startTime":"%s:%s"}\' "$KINGU_HOOK_AGENT_PID" "$kingu_agent_boot" "$kingu_agent_start") ;; esac',
    '  elif [ "$(uname -s 2>/dev/null)" = Darwin ]; then',
    // Why: lstart is local time; the host probe pins the same zone so the strings compare.
    '    kingu_agent_start=$(TZ=UTC0 LC_ALL=C /bin/ps -p "$KINGU_HOOK_AGENT_PID" -o lstart= 2>/dev/null | sed \'s/^ *//;s/ *$//\')',
    '    [ -z "$kingu_agent_start" ] || kingu_agent_process=$(printf \'{"pid":%s,"platform":"darwin","startTime":"%s"}\' "$KINGU_HOOK_AGENT_PID" "$kingu_agent_start")',
    '  fi ;;',
    'esac'
  ]
}
