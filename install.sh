#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
echo ""
echo "=== ChattingCursor 安装 (Linux/macOS) ==="
echo ""
bash ./scripts/install-all.sh "$@"
EXITCODE=$?
if [[ "${EXITCODE}" -eq 10 ]]; then
  echo ""
  echo "请重新打开终端（或执行 source ~/.bashrc）后运行: ./run.sh"
  exit 10
fi
if [[ "${EXITCODE}" -ne 0 ]]; then
  echo ""
  echo "安装失败，退出码 ${EXITCODE}"
  exit "${EXITCODE}"
fi
echo ""
echo "正在启动 ./run.sh ..."
exec ./run.sh
