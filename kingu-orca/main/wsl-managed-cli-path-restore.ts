/** Leads PATH with the managed WSL CLI after startup files ran; an unusable CLI only warns. */
export const WSL_MANAGED_CLI_PATH_RESTORE = `if [ -n "\${KINGU_WSL_CLI_DIR:-}" ]; then
  if [ -x "$KINGU_WSL_CLI_DIR/\${KINGU_CLI_COMMAND:-}" ]; then
    export PATH="$KINGU_WSL_CLI_DIR\${PATH:+:$PATH}"
  else
    printf 'Kingu CLI unavailable: cannot run %s. Check WSL Windows-drive mount options.\\n' "$KINGU_WSL_CLI_DIR/\${KINGU_CLI_COMMAND:-}" >&2
  fi
fi`
