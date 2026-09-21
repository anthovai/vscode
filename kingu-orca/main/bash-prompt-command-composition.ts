export const BASH_PROMPT_COMMAND_COMPOSITION_BLOCK = `__kingu_normalize_prompt_command_part() {
  local __kingu_value="$1" __kingu_output_name="$2" __kingu_character __kingu_chunk
  local __kingu_value_length=\${#1} __kingu_suffix_length=0 __kingu_backslash_length=0
  local __kingu_output_length __kingu_scan_start
  while (( __kingu_value_length - __kingu_suffix_length >= 1024 )); do
    __kingu_scan_start=$(( __kingu_value_length - __kingu_suffix_length - 1024 ))
    __kingu_chunk="\${__kingu_value:__kingu_scan_start:1024}"
    case "$__kingu_chunk" in
      *[!$' \\t\\n;']*) break ;;
      *) __kingu_suffix_length=$(( __kingu_suffix_length + 1024 )) ;;
    esac
  done
  while (( __kingu_suffix_length < __kingu_value_length )); do
    __kingu_character="\${__kingu_value: -__kingu_suffix_length - 1:1}"
    case "$__kingu_character" in
      ' '|$'\\t'|$'\\n'|';') __kingu_suffix_length=$(( __kingu_suffix_length + 1 )) ;;
      *) break ;;
    esac
  done
  __kingu_output_length=$(( \${#__kingu_value} - __kingu_suffix_length ))
  while (( __kingu_output_length - __kingu_backslash_length >= 1024 )); do
    __kingu_scan_start=$(( __kingu_output_length - __kingu_backslash_length - 1024 ))
    __kingu_chunk="\${__kingu_value:__kingu_scan_start:1024}"
    case "$__kingu_chunk" in
      *[!\\\\]*) break ;;
      *) __kingu_backslash_length=$(( __kingu_backslash_length + 1024 )) ;;
    esac
  done
  while (( __kingu_backslash_length < __kingu_output_length )); do
    __kingu_character="\${__kingu_value:__kingu_output_length - __kingu_backslash_length - 1:1}"
    [[ "$__kingu_character" == '\\' ]] || break
    __kingu_backslash_length=$(( __kingu_backslash_length + 1 ))
  done
  # Preserve the first separator when an odd backslash run escapes it.
  if (( __kingu_suffix_length > 0 && __kingu_backslash_length % 2 == 1 )); then
    __kingu_suffix_length=$(( __kingu_suffix_length - 1 ))
    __kingu_backslash_length=0
  fi
  __kingu_output_length=$(( \${#__kingu_value} - __kingu_suffix_length ))
  __kingu_value="\${__kingu_value:0:__kingu_output_length}"
  # Bash 4.4-5.0 scalar prompt evaluation preserves an odd terminal backslash.
  if (( __kingu_suffix_length == 0 && ((BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] == 0)) && __kingu_backslash_length % 2 == 1 )); then
    __kingu_value="$__kingu_value\\\\"
  fi
  printf -v "$__kingu_output_name" '%s' "$__kingu_value"
}
__kingu_restore_prompt_status() {
  return "$1"
}
__kingu_update_user_debug_trap() {
  local __kingu_debug_trap_spec="$1" __kingu_unchanged_debug_trap_spec="$2"
  local __kingu_debug_trap_command
  [[ "$__kingu_debug_trap_spec" != "$__kingu_unchanged_debug_trap_spec" ]] || return 0
  [[ "$__kingu_debug_trap_spec" != "trap -- '__kingu_osc133_preexec' DEBUG" ]] || return 0
  if [[ -z "$__kingu_debug_trap_spec" ]]; then
    __kingu_user_debug_trap=""
    unset __kingu_chained_debug_trap
    return 0
  fi
  __kingu_debug_trap_command="\${__kingu_debug_trap_spec#trap -- }"
  __kingu_debug_trap_command="\${__kingu_debug_trap_command% DEBUG}"
  eval "__kingu_user_debug_trap=$__kingu_debug_trap_command"
  unset __kingu_chained_debug_trap
}
__kingu_run_user_debug_trap() {
  if [[ -n "\${__kingu_user_debug_trap:-}" ]]; then
    eval "$__kingu_user_debug_trap" || true
  fi
}
__kingu_adopt_outer_debug_trap() {
  local __kingu_debug_trap_spec="\${__kingu_outer_debug_trap_spec:-}"
  unset __kingu_outer_debug_trap_spec
  __kingu_update_user_debug_trap "$__kingu_debug_trap_spec" "trap -- '__kingu_osc133_preexec' DEBUG"
}
__kingu_run_prompt_command_array() {
  local __kingu_exit_code="\${__kingu_prompt_status:-$?}" __kingu_prompt_part __kingu_prompt_index __kingu_user_count
  local __kingu_suffix_part
  local __kingu_final_prompt_command
  local __kingu_in_prompt_dispatch=1 __kingu_dispatching_user_prompt_command=""
  unset __kingu_prompt_status
  __kingu_adopt_outer_debug_trap
  trap '__kingu_osc133_preexec' DEBUG
  for __kingu_prompt_part in "\${__kingu_prompt_command_prefix[@]+"\${__kingu_prompt_command_prefix[@]}"}"; do
    if (( __kingu_exit_code == 0 )); then
      eval "$__kingu_prompt_part"
    else
      __kingu_restore_prompt_status "$__kingu_exit_code" || eval "$__kingu_prompt_part"
    fi
  done
  __kingu_user_count=0
  for __kingu_prompt_part in "\${__kingu_prompt_command_array[@]+"\${__kingu_prompt_command_array[@]}"}"; do
    __kingu_user_count=$(( __kingu_user_count + 1 ))
  done
  for (( __kingu_prompt_index = 0; __kingu_prompt_index + 1 < __kingu_user_count; __kingu_prompt_index++ )); do
    __kingu_prompt_part="\${__kingu_prompt_command_array[__kingu_prompt_index]}"
    __kingu_dispatching_user_prompt_command=1
    if (( __kingu_exit_code == 0 )); then
      eval "$__kingu_prompt_part"
    else
      __kingu_restore_prompt_status "$__kingu_exit_code" || eval "$__kingu_prompt_part"
    fi
    __kingu_dispatching_user_prompt_command=""
  done
  if (( __kingu_user_count > 0 )); then
    __kingu_prompt_part="\${__kingu_prompt_command_array[__kingu_user_count - 1]}"
    # Why: keep the final user hook and Kingu suffixes in one status-preserving eval.
    __kingu_final_prompt_command='eval "$__kingu_prompt_part"'
    for __kingu_suffix_part in "\${__kingu_prompt_command_suffix[@]+"\${__kingu_prompt_command_suffix[@]}"}"; do
      __kingu_final_prompt_command+=$'\\n'"$__kingu_suffix_part"
    done
    __kingu_dispatching_user_prompt_command=1
    if (( __kingu_exit_code == 0 )); then
      eval "$__kingu_final_prompt_command"
    else
      __kingu_restore_prompt_status "$__kingu_exit_code" || eval "$__kingu_final_prompt_command"
    fi
    __kingu_dispatching_user_prompt_command=""
  else
    for __kingu_prompt_part in "\${__kingu_prompt_command_suffix[@]+"\${__kingu_prompt_command_suffix[@]}"}"; do
      if (( __kingu_exit_code == 0 )); then
        eval "$__kingu_prompt_part"
      else
        __kingu_restore_prompt_status "$__kingu_exit_code" || eval "$__kingu_prompt_part"
      fi
    done
  fi
  return "$__kingu_exit_code"
}
__kingu_finish_legacy_prompt_dispatch() {
  local __kingu_suffix_part
  if [[ -n "\${__kingu_in_prompt_command:-}" ]]; then
    for __kingu_suffix_part in "\${__kingu_prompt_command_suffix[@]+"\${__kingu_prompt_command_suffix[@]}"}"; do
      eval "$__kingu_suffix_part"
    done
  fi
  trap '__kingu_osc133_preexec' DEBUG
  unset __kingu_in_legacy_prompt_wrapper
}
__kingu_normalize_prompt_command() {
  [[ -z "\${__kingu_prompt_command_normalized:-}" ]] || return 0
  local __kingu_prompt_part
  local -a __kingu_normalized=()
  for __kingu_prompt_part in "\${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}"; do
    __kingu_normalize_prompt_command_part "$__kingu_prompt_part" __kingu_prompt_part
    [[ -n "$__kingu_prompt_part" ]] && __kingu_normalized+=("$__kingu_prompt_part")
  done
  __kingu_prompt_command_normalized=1
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND=("\${__kingu_normalized[@]+"\${__kingu_normalized[@]}"}")
  else
    __kingu_prompt_command_array=("\${__kingu_normalized[@]+"\${__kingu_normalized[@]}"}")
    __kingu_prompt_command_prefix=()
    __kingu_prompt_command_suffix=()
    unset PROMPT_COMMAND
    # Why: PID scope distinguishes legacy prompt dispatch from ordinary user command text.
    __kingu_prompt_status_variable="__kingu_prompt_status_$$"
    __kingu_prompt_status_capture_command="$__kingu_prompt_status_variable=\\$?"
    __kingu_prompt_status_value="\\\${$__kingu_prompt_status_variable}"
    PROMPT_COMMAND="$__kingu_prompt_status_capture_command; __kingu_prompt_status=$__kingu_prompt_status_value"'; __kingu_prompt_had_functrace=""; if [[ -o functrace ]]; then __kingu_prompt_had_functrace=1; set +T; fi; __kingu_outer_debug_trap_spec="$(trap -p DEBUG)"; [[ -z "$__kingu_prompt_had_functrace" ]] || set -T; unset __kingu_prompt_had_functrace; __kingu_run_prompt_command_array; __kingu_finish_legacy_prompt_dispatch'
  fi
}
__kingu_prepend_prompt_command() {
  local command="$1"
  __kingu_normalize_prompt_command
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND=("$command" "\${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}")
  else
    __kingu_prompt_command_prefix=("$command" "\${__kingu_prompt_command_prefix[@]+"\${__kingu_prompt_command_prefix[@]}"}")
  fi
}
__kingu_append_prompt_command() {
  local command="$1"
  __kingu_normalize_prompt_command
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND+=("$command")
  else
    __kingu_prompt_command_suffix+=("$command")
  fi
}`
