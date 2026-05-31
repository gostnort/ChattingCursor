#!/usr/bin/env bash
# 停止本机 ChattingCursor 相关进程（委托 scripts/shutdown-all.sh）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${ROOT}/scripts/shutdown-all.sh" "$@"
