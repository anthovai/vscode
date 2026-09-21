export type PosixCommandPathLookupTarget =
  | { kind: 'literal'; value: string }
  | { kind: 'shell-variable'; name: string }

const SHELL_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export type PosixCommandPathLookupOptions = {
  /**
   * Skip PATH components that are Windows drives mounted into the guest.
   *
   * WSL appends the Windows PATH to the guest PATH, so a Windows `claude` can
   * sit ahead of a real guest install. Rejecting the result AFTER the walk is
   * not equivalent: the walk stops at the first hit, so discarding it reports
   * "not installed" for a user who has both. Skipping the component keeps the
   * walk going and finds the guest binary behind it.
   *
   * Matched by mount metadata, not by a `/mnt` name: the automount root is
   * configurable, and `/mnt` is an ordinary directory name on a Linux box.
   */
  skipWindowsMountDirs?: boolean
}

export function buildPosixCommandPathLookupScript(
  target: PosixCommandPathLookupTarget,
  options: PosixCommandPathLookupOptions = {}
): string {
  const commandAssignment = buildCommandAssignment(target)
  // `drvfs` is what WSL mounts a Windows drive as, wherever the automount root
  // is; 9p/virtiofs cover the WSL2 shapes.
  //
  // `${x+set}` so the table is read once per SHELL, not once per lookup: the
  // caller embeds this script inside `for cmd in <every agent>`, so an
  // unconditional assignment forked awk once per probed CLI -- 36 of them
  // against a 10s budget. The variable outlives the iteration, so the second
  // pass finds it set. Deliberately not `[ -n ... ]`: a host with no Windows
  // mounts yields the empty string, which must still count as read.
  const mountPrelude = options.skipWindowsMountDirs
    ? [
        '[ "${_kingu_win_mounts+set}" = set ] || _kingu_win_mounts=$(awk \'$3 == "drvfs" || $3 == "9p" || $3 == "virtiofs" { print $2 }\' /proc/mounts 2>/dev/null)'
      ]
    : []
  const skipMountComponent = options.skipWindowsMountDirs
    ? [
        '      for _kingu_win_mount in $_kingu_win_mounts; do',
        '        case "$_kingu_lookup_component/" in',
        '          "$_kingu_win_mount"/*) _kingu_lookup_component= ;;',
        '        esac',
        '      done',
        '      if [ -z "$_kingu_lookup_component" ]; then',
        '        [ -n "$_kingu_lookup_has_more" ] || break',
        '        continue',
        '      fi'
      ]
    : []
  // Shell command resolution can be masked by aliases, functions, and builtins, so inspect PATH.
  return [
    `_kingu_lookup_command=${commandAssignment}`,
    'resolved=',
    ...mountPrelude,
    'case "$_kingu_lookup_command" in',
    '  */*)',
    '    case "$_kingu_lookup_command" in',
    '      /*) _kingu_lookup_candidate=$_kingu_lookup_command ;;',
    '      *) _kingu_lookup_candidate=${PWD%/}/$_kingu_lookup_command ;;',
    '    esac',
    '    if [ -x "$_kingu_lookup_candidate" ] && [ ! -d "$_kingu_lookup_candidate" ]; then',
    '      resolved=$_kingu_lookup_candidate',
    '    fi',
    '    ;;',
    '  *)',
    '    _kingu_lookup_remaining=${PATH-}',
    '    while :; do',
    '      case "$_kingu_lookup_remaining" in',
    '        *:*)',
    '          _kingu_lookup_component=${_kingu_lookup_remaining%%:*}',
    '          _kingu_lookup_remaining=${_kingu_lookup_remaining#*:}',
    '          _kingu_lookup_has_more=1',
    '          ;;',
    '        *)',
    '          _kingu_lookup_component=$_kingu_lookup_remaining',
    '          _kingu_lookup_has_more=',
    '          ;;',
    '      esac',
    ...skipMountComponent,
    '      [ -n "$_kingu_lookup_component" ] || _kingu_lookup_component=.',
    '      case "$_kingu_lookup_component" in',
    '        /*) _kingu_lookup_candidate=$_kingu_lookup_component/$_kingu_lookup_command ;;',
    '        *) _kingu_lookup_candidate=${PWD%/}/$_kingu_lookup_component/$_kingu_lookup_command ;;',
    '      esac',
    '      if [ -x "$_kingu_lookup_candidate" ] && [ ! -d "$_kingu_lookup_candidate" ]; then',
    '        resolved=$_kingu_lookup_candidate',
    '        break',
    '      fi',
    '      [ -n "$_kingu_lookup_has_more" ] || break',
    '    done',
    '    ;;',
    'esac'
  ].join('\n')
}

function buildCommandAssignment(target: PosixCommandPathLookupTarget): string {
  if (target.kind === 'literal') {
    return shellQuote(target.value)
  }
  if (!SHELL_VARIABLE_NAME_PATTERN.test(target.name)) {
    throw new Error(`Invalid shell variable name: ${target.name}`)
  }
  return `\${${target.name}-}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
