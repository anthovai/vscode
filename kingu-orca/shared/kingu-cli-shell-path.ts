export const KINGU_CLI_POSIX_PATH_RESTORE = `if [ -n "\${KINGU_CLI_BIN_DIR:-}" ]; then
  case "\${PATH:-}" in
    "$KINGU_CLI_BIN_DIR"|"$KINGU_CLI_BIN_DIR":*) ;;
    *) export PATH="$KINGU_CLI_BIN_DIR\${PATH:+:$PATH}" ;;
  esac
fi`
