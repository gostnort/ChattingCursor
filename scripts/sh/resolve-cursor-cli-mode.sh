#!/usr/bin/env bash
# Linux：未设置时若本机有 cursor-agent 则 CURSOR_CLI_MODE=native（不依赖 WSL）

init_cursor_cli_mode() {
  if [[ -n "${CURSOR_CLI_MODE:-}" ]]; then
    return
  fi
  if command -v cursor-agent >/dev/null 2>&1; then
    export CURSOR_CLI_MODE=native
    return
  fi
  local candidate="${HOME}/.local/bin/cursor-agent"
  if [[ -x "${candidate}" ]]; then
    export CURSOR_CLI_MODE=native
  fi
}
