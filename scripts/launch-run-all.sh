#!/usr/bin/env bash
# 后台启动 run-all.sh 并轮询日志，完成后退出（与 launch-run-all.ps1 对齐）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sh/common.sh
source "${SCRIPT_DIR}/sh/common.sh"
# shellcheck source=sh/resolve-cursor-cli-mode.sh
source "${SCRIPT_DIR}/sh/resolve-cursor-cli-mode.sh"
# shellcheck source=sh/resolve-token-sync-dir.sh
source "${SCRIPT_DIR}/sh/resolve-token-sync-dir.sh"
# shellcheck source=sh/resolve-cloudflare-tunnel.sh
source "${SCRIPT_DIR}/sh/resolve-cloudflare-tunnel.sh"

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
TOKEN_SYNC_DIR_SOURCE="$(resolve_token_sync_dir_source "")"
TOKEN_SYNC_DIR="$(resolve_token_sync_dir "")"
ensure_token_sync_dir_ready "${TOKEN_SYNC_DIR}" "${TOKEN_SYNC_DIR_SOURCE}" || exit 1
export CHATTINGCURSOR_TOKEN_SYNC_DIR="${TOKEN_SYNC_DIR}"
TOKEN_FILE="${TOKEN_SYNC_DIR}/chattingcursor-token.txt"
TUNNEL_URL_PATTERN='https://[a-z0-9-]+\.trycloudflare\.com'
NAMED_PUBLIC_URL=""
if named_lines="$(read_named_tunnel_public_url 2>/dev/null)"; then
  NAMED_PUBLIC_URL="$(echo "${named_lines}" | sed -n '2p')"
fi

RUN_ARGS=()
if [[ "${NO_WEB}" -eq 0 ]]; then
  RUN_ARGS+=("-WithWeb")
fi
if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  RUN_ARGS+=("${EXTRA_ARGS[@]}")
fi

rm -f "${LOG_PATH}" "${ERR_PATH}"


token_file_public_url() {
  if [[ ! -f "${TOKEN_FILE}" ]]; then
    return 1
  fi
  grep -E '^\s*publicBridgeUrl:\s*' "${TOKEN_FILE}" | tail -n 1 | sed -E 's/^\s*publicBridgeUrl:\s*//;s/\s*$//;s/\/$//'
}


test_token_file_has_expected_public_url() {
  local on_disk
  on_disk="$(token_file_public_url || true)"
  [[ -n "${on_disk}" ]] || return 1
  if [[ "${on_disk}" =~ ^https?://127\.0\.0\.1 || "${on_disk}" =~ ^https?://localhost ]]; then
    return 1
  fi
  if [[ -n "${NAMED_PUBLIC_URL}" ]]; then
    [[ "${on_disk}" == "${NAMED_PUBLIC_URL}" ]]
    return
  fi
  grep -qE "${TUNNEL_URL_PATTERN}" "${TOKEN_FILE}"
}


public_tunnel_health_ok() {
  local url
  url="$(token_file_public_url || true)"
  [[ -n "${url}" ]] || return 1
  curl -fsS --max-time 15 "${url}/health" 2>/dev/null | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'
}


test_startup_ready_via_token() {
  test_token_file_has_expected_public_url && public_tunnel_health_ok
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

# run-all 隧道健康检查最多 90s，另加 Bridge/Web 就绪时间
STARTUP_WAIT_SECONDS=330
deadline=$((SECONDS + STARTUP_WAIT_SECONDS))

CHATTINGCURSOR_TOKEN_SYNC_DIR="${TOKEN_SYNC_DIR}" nohup bash "${SCRIPT_DIR}/run-all.sh" "${RUN_ARGS[@]}" >"${LOG_PATH}" 2>"${ERR_PATH}" &
PROC_PID=$!
echo "ChattingCursor 已在后台启动 (PID ${PROC_PID})..."
echo "日志: ${LOG_PATH}"
echo "错误: ${ERR_PATH}"

startup_ok=0
startup_fail=0

while [[ "${SECONDS}" -lt "${deadline}" ]]; do
  if ! kill -0 "${PROC_PID}" 2>/dev/null; then
    break
  fi
  if [[ -f "${LOG_PATH}" ]]; then
    if tail -n 80 "${LOG_PATH}" 2>/dev/null | grep -qE '\[FAIL\].*端口 4321|exit 2'; then
      startup_fail=1
      break
    fi
    if tail -n 80 "${LOG_PATH}" 2>/dev/null | grep -q 'Startup flow complete'; then
      startup_ok=1
      break
    fi
  fi
  sleep 0.5
done

if [[ "${startup_ok}" -eq 0 && "${startup_fail}" -eq 0 ]]; then
  if test_startup_ready_via_token; then
    startup_ok=1
  fi
fi

echo ""
if [[ "${startup_ok}" -eq 1 ]]; then
  echo "[OK] Startup flow complete. 服务在后台继续运行。"
  echo "     查看 token 文件 chattingcursor-token.txt 中的 pid.* 行。"
  echo "     停止: ./shutdown.sh"
  echo "     日志: ${LOG_PATH}"
  exit 0
fi

if [[ "${startup_fail}" -eq 1 ]]; then
  echo "[FAIL] 启动未成功。日志: ${LOG_PATH}"
  print_startup_log_tail
  exit 2
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

echo "[OK] 后台启动器仍在运行 (PID ${PROC_PID})。"
echo "     请查看日志中的 \"Startup flow complete\": ${LOG_PATH}"
echo "     停止: ./shutdown.sh"
exit 0
