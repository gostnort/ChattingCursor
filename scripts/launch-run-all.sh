#!/usr/bin/env bash
# 后台启动 run-all.sh 并轮询日志，完成后退出（与 launch-run-all.ps1 对齐）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sh/common.sh
source "${SCRIPT_DIR}/sh/common.sh"
# shellcheck source=sh/resolve-cursor-cli-mode.sh
source "${SCRIPT_DIR}/sh/resolve-cursor-cli-mode.sh"

NO_WEB=0
EXTRA_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -NoWeb|--no-web) NO_WEB=1 ;;
    *) EXTRA_ARGS+=("$1") ;;
  esac
  shift
done

ROOT="$(chattingcursor_repo_root)"
cd "${ROOT}"
init_cursor_cli_mode

TMP_BASE="$(chattingcursor_temp_dir)"
LOG_PATH="${TMP_BASE}/chattingcursor-run-all.log"
ERR_PATH="${TMP_BASE}/chattingcursor-run-all.err.log"
RUN_ARGS=()
if [[ "${NO_WEB}" -eq 0 ]]; then
  RUN_ARGS+=("-WithWeb")
fi
if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  RUN_ARGS+=("${EXTRA_ARGS[@]}")
fi

rm -f "${LOG_PATH}" "${ERR_PATH}"

test_local_services_healthy() {
  local require_web="${1:-0}"
  if ! curl -fsS "http://127.0.0.1:4321/health" >/dev/null 2>&1; then
    return 1
  fi
  if [[ "${require_web}" -eq 0 ]]; then
    return 0
  fi
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:43210/ChattingCursor/" 2>/dev/null || echo 000)"
  [[ "${code}" =~ ^[2345] ]]
}


print_startup_log_tail() {
  if [[ -f "${ERR_PATH}" ]]; then
    echo "--- stderr (last 40 lines) ---"
    tail -n 40 "${ERR_PATH}"
  fi
  if [[ -f "${LOG_PATH}" ]]; then
    echo "--- stdout (last 40 lines) ---"
    tail -n 40 "${LOG_PATH}"
  fi
}

# run-all 隧道健康检查最多 180s，Bridge/Web 就绪另需时间
STARTUP_WAIT_SECONDS=330
deadline=$((SECONDS + STARTUP_WAIT_SECONDS))

nohup bash "${SCRIPT_DIR}/run-all.sh" "${RUN_ARGS[@]}" >"${LOG_PATH}" 2>"${ERR_PATH}" &
PROC_PID=$!
echo "ChattingCursor 已在后台启动 (PID ${PROC_PID})..."
echo "日志: ${LOG_PATH}"
echo "错误: ${ERR_PATH}"

startup_ok=0
require_web=0
if [[ "${NO_WEB}" -eq 0 ]]; then
  require_web=1
fi

while [[ "${SECONDS}" -lt "${deadline}" ]]; do
  if ! kill -0 "${PROC_PID}" 2>/dev/null; then
    break
  fi
  if [[ -f "${LOG_PATH}" ]] && grep -q 'Startup flow complete' "${LOG_PATH}" 2>/dev/null; then
    startup_ok=1
    break
  fi
  sleep 0.5
done

if [[ "${startup_ok}" -eq 0 ]] && test_local_services_healthy "${require_web}"; then
  startup_ok=1
fi

echo ""
if [[ "${startup_ok}" -eq 1 ]]; then
  echo "[OK] 启动完成。服务在后台继续运行。"
  echo "     查看 token 文件 chattingcursor-token.txt 中的 pid 行。"
  echo "     停止: ./shutdown.sh"
  echo "     日志: ${LOG_PATH}"
  exit 0
fi

if ! kill -0 "${PROC_PID}" 2>/dev/null; then
  set +e
  wait "${PROC_PID}" 2>/dev/null
  exit_code=$?
  set -e
  if [[ "${exit_code}" -eq 2 ]]; then
    echo "[FAIL] 端口冲突 (exit 2)。日志: ${LOG_PATH}"
    print_startup_log_tail
    exit 2
  fi
  if [[ "${exit_code}" -ne 0 ]]; then
    echo "[FAIL] 启动未成功 (exit ${exit_code})。日志: ${LOG_PATH}"
    print_startup_log_tail
    exit "${exit_code}"
  fi
  echo "[FAIL] 启动流程已结束但未就绪。日志: ${LOG_PATH}"
  print_startup_log_tail
  exit 1
fi

echo "[FAIL] 启动超时（${STARTUP_WAIT_SECONDS}s 内未检测到 Startup flow complete）。日志: ${LOG_PATH}"
print_startup_log_tail
exit 1
