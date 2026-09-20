import { getPosixOmpShellWrapper } from '../pty/omp-shell-wrapper'
import { getPosixCodexShellLaunchPreflight } from '../pty/codex-shell-launch-preflight'
import { BASH_PROMPT_COMMAND_COMPOSITION_BLOCK } from '../bash-prompt-command-composition'
import { BASH_FEATURE_CHANNEL_BLOCK, SHELL_STARTUP_IDENTITY_MARKER_BLOCK } from '../shell-templates'

export function getDaemonBashShellReadyRcfileContent(): string {
  return `# Kingu daemon bash shell-ready wrapper
${BASH_FEATURE_CHANNEL_BLOCK}
${SHELL_STARTUP_IDENTITY_MARKER_BLOCK}
# Why a plain variable: the channel is consumed and destroyed in these first
# lines, so nothing this shell later spawns can see or inherit the selection.
__kingu_ready_marker=""
__kingu_has_feature ready && __kingu_ready_marker=1
unset _kingu_shell_features
unset -f __kingu_has_feature
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
# Why: enable bracketed paste so Kingu can deliver a multiline startup prompt as
# a single literal paste (ESC[200~…ESC[201~); without it, older readline builds
# treat each embedded newline as Enter and mangle the prompt into PS2
# continuation. Modern readline defaults this on; force it for the rest.
[[ $- == *i* ]] && bind 'set enable-bracketed-paste on' 2>/dev/null
__kingu_restore_agent_teams_path() {
  [[ -n "\${KINGU_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0
  case "$PATH" in
    "\${KINGU_AGENT_TEAMS_SHIM_DIR}"|"\${KINGU_AGENT_TEAMS_SHIM_DIR}:"*) return 0 ;;
  esac
  export PATH="\${KINGU_AGENT_TEAMS_SHIM_DIR}:$PATH"
}
__kingu_restore_agent_teams_path
# Why: user startup files may set the default OpenCode config after Kingu's
# spawn env; restore the Kingu-managed config dir before the first prompt.
[[ -n "\${KINGU_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${KINGU_OPENCODE_CONFIG_DIR}"
[[ -n "\${KINGU_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${KINGU_MIMOCODE_HOME}"
${getPosixOmpShellWrapper()}
# Why: Codex must keep using Kingu's runtime CODEX_HOME after profile scripts.
[[ -n "\${KINGU_CODEX_HOME:-}" ]] && export CODEX_HOME="\${KINGU_CODEX_HOME}"
${getPosixCodexShellLaunchPreflight()}
# Why: emit OSC 133 C/D so terminal-command-lifecycle can drop stale agent
# status when the foreground command exits — mirrors the zsh daemon wrapper.
# Without this, bash users (default on most Linux distros) keep a stuck
# 'working' spinner after the CLI exits without a Stop/SessionEnd hook.
__kingu_initializing_wrapper=1
__kingu_osc133_precmd() {
  local exit_code=$?
  __kingu_in_prompt_command=1
  if [[ -n "\${__kingu_in_command:-}" ]]; then
    printf "\\033]133;D;%s\\007" "$exit_code"
    unset __kingu_in_command
  fi
  printf "\\033]133;A\\007"
  return "$exit_code"
}
__kingu_osc133_preexec() {
  if [[ -n "\${__kingu_prompt_status_capture_command:-}" && "$BASH_COMMAND" == "$__kingu_prompt_status_capture_command" ]]; then
    unset __kingu_initial_prompt
    __kingu_in_legacy_prompt_wrapper=1
    return 0
  fi
  if [[ -n "\${__kingu_initializing_wrapper:-}\${__kingu_in_debug_capture:-}\${__kingu_initial_prompt:-}\${__kingu_in_prompt_dispatch:-}\${__kingu_in_legacy_prompt_wrapper:-}\${__kingu_in_prompt_command:-}" ]]; then
    [[ -z "\${__kingu_initializing_wrapper:-}\${__kingu_in_debug_capture:-}" ]] || return 0
    if [[ -n "\${__kingu_initial_prompt:-}" && "$BASH_COMMAND" == "__kingu_osc133_precmd" ]]; then
      unset __kingu_initial_prompt; return 0
    fi
    if [[ -n "\${__kingu_in_prompt_dispatch:-}" ]]; then
      [[ -n "\${__kingu_dispatching_user_prompt_command:-}" ]] || return 0
      if [[ "\${FUNCNAME[1]:-}" == "__kingu_run_prompt_command_array" ]]; then
        case "$BASH_COMMAND" in
          '(( __kingu_exit_code == 0 ))'|'__kingu_restore_prompt_status "$__kingu_exit_code"'|'eval "$__kingu_prompt_part"'|'eval "$__kingu_final_prompt_command"'|__kingu_dispatching_user_prompt_command=*|__kingu_osc133_precmd|__kingu_osc133_epilogue) return 0 ;;
        esac
      fi
    elif [[ "\${FUNCNAME[1]:-}" == "__kingu_run_prompt_command_array" || "$BASH_COMMAND" == "__kingu_run_prompt_command_array" ]]; then
      return 0
    fi
    [[ -z "\${__kingu_in_legacy_prompt_wrapper:-}" || -n "\${__kingu_dispatching_user_prompt_command:-}" ]] || return 0
    if [[ -n "\${__kingu_in_prompt_command:-}" && "$BASH_COMMAND" == "__kingu_in_debug_capture=1" ]]; then
      return 0
    fi
  fi
  case "\${FUNCNAME[1]:-}" in
    __kingu_osc133_*|__kingu_restore_prompt_status|__bp_*) return 0 ;;
  esac
  case "$BASH_COMMAND" in
    __kingu_osc133_precmd|__kingu_osc133_epilogue) return 0 ;;
    # The prefix is only special while bash-preexec prompt hooks run.
    __bp_*) [[ -n "\${__kingu_in_prompt_command:-}" ]] && return 0 ;;
  esac
  __kingu_run_user_debug_trap
  # Why: a framework (bash-preexec/starship) may replace our DEBUG trap at the
  # first prompt; __kingu_osc133_epilogue re-takes it each prompt and stores the
  # framework's trap here, so the framework's own preexec still runs while our
  # command-start C survives its re-arm.
  if [[ -n "\${__kingu_chained_debug_trap:-}" ]]; then
    eval "$__kingu_chained_debug_trap" || true
  fi
  [[ -z "\${__kingu_in_prompt_command:-}" ]] || return 0
  # Why: a chained trap can invoke us more than once for a single command, so
  # emit C only on the first fire (the __kingu_in_command gate), and never for a
  # prompt-time hook — ours or bash-preexec's __bp_* helpers.
  [[ -z "\${__kingu_in_command:-}" ]] || return 0
  printf "\\033]133;C\\007"
  __kingu_in_command=1
}
# Why: adopt the latest user trap before Kingu retakes lifecycle ownership.
__kingu_osc133_epilogue() {
  unset __kingu_in_prompt_command
  __kingu_adopt_outer_debug_trap
  trap '__kingu_osc133_preexec' DEBUG
  # Readline renders PS1 after entering raw mode; prompt hooks still run in cooked mode.
  if [[ -n "$__kingu_ready_marker" ]]; then
    PS1="\${PS1-}"'\\[\\e]777;kingu-shell-ready\\a\\]'
    __kingu_ready_marker=""
  fi
}
${BASH_PROMPT_COMMAND_COMPOSITION_BLOCK}
__kingu_prepend_prompt_command "__kingu_osc133_precmd"
__kingu_append_prompt_command '__kingu_in_debug_capture=1; __kingu_prompt_had_functrace=""; if [[ -o functrace ]]; then __kingu_prompt_had_functrace=1; set +T; fi; __kingu_outer_debug_trap_spec="$(trap -p DEBUG)"; [[ -z "$__kingu_prompt_had_functrace" ]] || set -T; unset __kingu_prompt_had_functrace __kingu_in_debug_capture'
__kingu_append_prompt_command "__kingu_osc133_epilogue"
__kingu_had_functrace=""
[[ -o functrace ]] && __kingu_had_functrace=1
set +T
__kingu_debug_trap_spec="$(trap -p DEBUG)"
[[ -z "$__kingu_had_functrace" ]] || set -T
if [[ -n "$__kingu_debug_trap_spec" && "$__kingu_debug_trap_spec" != "trap -- '__kingu_osc133_preexec' DEBUG" ]]; then
  __kingu_debug_trap_command="\${__kingu_debug_trap_spec#trap -- }"
  __kingu_debug_trap_command="\${__kingu_debug_trap_command% DEBUG}"
  eval "__kingu_user_debug_trap=$__kingu_debug_trap_command"
fi
unset __kingu_debug_trap_spec __kingu_debug_trap_command __kingu_had_functrace
unset -f __kingu_normalize_prompt_command_part __kingu_normalize_prompt_command __kingu_prepend_prompt_command __kingu_append_prompt_command
unset __kingu_prompt_command_normalized
# Why: arm DEBUG after wrapper setup; otherwise bash treats our own rcfile
# commands as a foreground command and emits a fake C/D before the first prompt.
__kingu_initial_prompt=1
trap '__kingu_osc133_preexec' DEBUG
unset __kingu_initializing_wrapper
`
}
