#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
echo ""
echo "=== ChattingCursor 安装 (Linux/macOS) ==="
echo ""

on_install_signal() {
  echo ""
  echo "安装已中断。"
  exit 130
}
trap on_install_signal INT TERM

bash ./scripts/install-all.sh "$@"
EXITCODE=$?
trap - INT TERM

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
echo "正在后台启动 ./run.sh ..."
bash ./scripts/launch-run-all.sh "$@" &
LAUNCHER_PID=$!
disown "${LAUNCHER_PID}" 2>/dev/null || true

# shellcheck source=scripts/sh/common.sh
source "$(dirname "$0")/scripts/sh/common.sh"
TMP_BASE="$(chattingcursor_temp_dir)"
echo ""
echo "安装完成。服务正在后台启动（启动器 PID ${LAUNCHER_PID}）。"
echo "启动日志: ${TMP_BASE}/chattingcursor-run-all.log"
echo "停止服务: ./shutdown.sh"
echo "若启动失败，请单独运行: ./run.sh"
exit 0
