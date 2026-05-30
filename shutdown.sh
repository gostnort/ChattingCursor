#!/usr/bin/env bash
# 停止本机 ChattingCursor 相关进程（Bridge / Web / cloudflared）
set -euo pipefail

stop_port() {
  local port="$1"
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -t -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "${pids}" ]]; then
      kill ${pids} 2>/dev/null || true
    fi
  fi
}

pkill -f 'chattingcursor|dev:bridge|dev:web|cloudflared tunnel' 2>/dev/null || true
stop_port 4321
stop_port 43210
echo "[OK] 已尝试停止 Bridge (4321)、Web (43210) 与 cloudflared。"
