import { basename, win32 as pathWin32 } from 'node:path'

export const POSIX_SHELL_STARTUP_COMMAND_ENV = 'KINGU_POSIX_SHELL_STARTUP_COMMAND'

export function supportsPosixShellStartupCommand(shellPath: string): boolean {
  const shellName = pathWin32.basename(basename(shellPath)).toLowerCase()
  return shellName === 'bash' || shellName === 'zsh' || shellName === 'fish'
}

export function getBashStartupCommandPromptBlock(): string {
  return `if [[ \${${POSIX_SHELL_STARTUP_COMMAND_ENV}+present} == present ]]; then
  __kingu_remove_startup_command_prompt_hook() {
    local __kingu_item
    local -a __kingu_remaining=()
    if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
      for __kingu_item in "\${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}"; do
        [[ "$__kingu_item" == "__kingu_run_startup_command" ]] || __kingu_remaining+=("$__kingu_item")
      done
      PROMPT_COMMAND=("\${__kingu_remaining[@]+"\${__kingu_remaining[@]}"}")
    else
      for __kingu_item in "\${__kingu_prompt_command_suffix[@]+"\${__kingu_prompt_command_suffix[@]}"}"; do
        [[ "$__kingu_item" == "__kingu_run_startup_command" ]] || __kingu_remaining+=("$__kingu_item")
      done
      __kingu_prompt_command_suffix=("\${__kingu_remaining[@]+"\${__kingu_remaining[@]}"}")
    fi
  }
  __kingu_run_startup_command() {
    local __kingu_command="$${POSIX_SHELL_STARTUP_COMMAND_ENV}" __kingu_status
    unset ${POSIX_SHELL_STARTUP_COMMAND_ENV}
    __kingu_remove_startup_command_prompt_hook
    unset -f __kingu_remove_startup_command_prompt_hook
    builtin history -s "$__kingu_command" 2>/dev/null || true
    builtin printf '%s\n' "$__kingu_command"
    eval "$__kingu_command"
    __kingu_status=$?
    unset -f __kingu_run_startup_command
    return "$__kingu_status"
  }
  __kingu_append_prompt_command "__kingu_run_startup_command"
fi`
}
