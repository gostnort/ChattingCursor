#!/usr/bin/env bash
# Linux/macOS 一键启动：Bridge + Web + cloudflared quick/named tunnel
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sh/common.sh
source "${SCRIPT_DIR}/sh/common.sh"
# shellcheck source=sh/resolve-token-sync-dir.sh
source "${SCRIPT_DIR}/sh/resolve-token-sync-dir.sh"
# shellcheck source=sh/resolve-cursor-cli-mode.sh
source "${SCRIPT_DIR}/sh/resolve-cursor-cli-mode.sh"
# shellcheck source=sh/resolve-cloudflare-tunnel.sh
source "${SCRIPT_DIR}/sh/resolve-cloudflare-tunnel.sh"
# shellcheck source=sh/token-file-pids.sh
source "${SCRIPT_DIR}/sh/token-file-pids.sh"
# shellcheck source=sh/token-file-name.sh
source "${SCRIPT_DIR}/sh/token-file-name.sh"

BRIDGE_PORT=4321
WEB_PORT=43210
WITH_WEB=1
TOKEN_SYNC_DIR_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -NoWeb|--no-web) WITH_WEB=0 ;;
    -WithWeb|--with-web) WITH_WEB=1 ;;
    -BridgePort) BRIDGE_PORT="${2:-4321}"; shift ;;
    -WebPort) WEB_PORT="${2:-43210}"; shift ;;
    -TokenSyncDir) TOKEN_SYNC_DIR_OVERRIDE="${2:-}"; shift ;;
    *) ;;
  esac
  shift
done

ROOT="$(chattingcursor_repo_root)"
cd "${ROOT}"
init_cursor_cli_mode

TMP_BASE="$(chattingcursor_temp_dir)"
TUNNEL_LOG="${TMP_BASE}/chattingcursor-cloudflared.log"
BRIDGE_LOG="${TMP_BASE}/chattingcursor-bridge.log"
BRIDGE_ERR_LOG="${TMP_BASE}/chattingcursor-bridge.err.log"
TOKEN_SYNC_DIR_SOURCE="$(resolve_token_sync_dir_source "${TOKEN_SYNC_DIR_OVERRIDE}")"
TOKEN_SYNC_DIR="$(resolve_token_sync_dir "${TOKEN_SYNC_DIR_OVERRIDE}")"
export CHATTINGCURSOR_TOKEN_SYNC_DIR="${TOKEN_SYNC_DIR}"
TOKEN_FILE="$(chattingcursor_token_file_path "${TOKEN_SYNC_DIR}")"
TUNNEL_URL_PATTERN='https://[a-z0-9-]+\.trycloudflare\.com'
TUNNEL_URL_HTTP_PATTERN='http://[a-z0-9-]+\.trycloudflare\.com'

BRIDGE_PID=""
WEB_PID=""
TUNNEL_PID=""
BRIDGE_OWNED=0
WEB_OWNED=0
TUNNEL_OWNED=0
NAMED_TUNNEL_NAME=""
NAMED_PUBLIC_URL=""
SHUTTING_DOWN=0
TUNNEL_URL_APPLIED=0
DETECTED_TUNNEL_URL=""
TUNNEL_LOG_OFFSET=0
STARTUP_PUBLIC_HEALTH_WAIT_DONE=0
STARTUP_TUNNEL_RECOVERY_ATTEMPTED=0

declare -A SERVICE_PIDS=()

ensure_token_sync_dir_ready "${TOKEN_SYNC_DIR}" "${TOKEN_SYNC_DIR_SOURCE}" || exit 1


read_named_tunnel_config() {
  local lines
  if ! lines="$(read_named_tunnel_public_url 2>/dev/null)"; then
    return 1
  fi
  NAMED_TUNNEL_NAME="$(echo "${lines}" | sed -n '1p')"
  NAMED_PUBLIC_URL="$(echo "${lines}" | sed -n '2p')"
}


resolve_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then
    command -v cloudflared
    return
  fi
  local candidate="${HOME}/.local/bin/cloudflared"
  if [[ -x "${candidate}" ]]; then
    echo "${candidate}"
    return
  fi
  return 1
}


port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q ":${port} "
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"${port}" -sTCP:LISTEN -Pn >/dev/null 2>&1
    return
  fi
  return 1
}


bridge_healthy() {
  curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null 2>&1
}


web_healthy() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/ChattingCursor/" 2>/dev/null || echo 000)"
  [[ "${code}" =~ ^[2345] ]]
}


start_chrome() {
  log_step "Starting Google Chrome with remote debugging port 9222..."
  if command -v google-chrome >/dev/null 2>&1; then
    google-chrome --remote-debugging-port=9222 --no-first-run --no-default-browser-check --disable-fre "http://127.0.0.1:${WEB_PORT}/ChattingCursor/" >/dev/null 2>&1 &
    log_ok "Chrome started in background."
  elif command -v google-chrome-stable >/dev/null 2>&1; then
    google-chrome-stable --remote-debugging-port=9222 --no-first-run --no-default-browser-check --disable-fre "http://127.0.0.1:${WEB_PORT}/ChattingCursor/" >/dev/null 2>&1 &
    log_ok "Chrome started in background."
  elif [[ "$OSTYPE" == "darwin"* ]]; then
    /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --no-first-run --no-default-browser-check --disable-fre "http://127.0.0.1:${WEB_PORT}/ChattingCursor/" >/dev/null 2>&1 &
    log_ok "Chrome started in background."
  else
    echo "Could not find chrome executable. You may need to start it manually."
  fi
}

ensure_project_ready() {
  if [[ ! -d "${ROOT}/node_modules" ]]; then
    log_step "首次运行，安装依赖..."
    bash "${SCRIPT_DIR}/install-all.sh" --skip-cloudflared
  fi
  if [[ ! -d "${ROOT}/packages/shared/dist" ]]; then
    log_step "构建 shared 包..."
    pnpm --filter @chatting-cursor/shared build
  fi
  if [[ ! -d "${ROOT}/packages/cli-client/dist" ]]; then
    log_step "构建 cli-client..."
    pnpm --filter @chatting-cursor/cli-client build
  fi
}


initialize_fresh_startup_pid_tracking() {
  SERVICE_PIDS=()
  SERVICE_PIDS[run-all]=$$
  clear_token_file_pid_section "${TOKEN_FILE}"
  sync_service_pids_to_token_file
}


set_service_pid() {
  local key="$1"
  local pid="$2"
  if [[ -z "${pid}" || "${pid}" -le 0 ]]; then
    return 0
  fi
  SERVICE_PIDS["${key}"]="${pid}"
  sync_service_pids_to_token_file
}


sync_service_pids_to_token_file() {
  local cloudflared_only="${1:-0}"
  merge_token_file_pid_section "${TOKEN_FILE}" SERVICE_PIDS "${cloudflared_only}"
}


restore_service_pids_after_bridge_token_write() {
  sync_service_pids_to_token_file
}


ensure_https_public_bridge_url() {
  local normalized="${1%/}"
  normalized="$(echo "${normalized}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ "${normalized}" =~ ^https?:// ]]; then
    if [[ "${normalized}" =~ ^http://[a-z0-9-]+\.trycloudflare\.com ]]; then
      echo "https://${normalized#http://}"
      return
    fi
    echo "${normalized}"
    return
  fi
  if [[ "${normalized}" =~ ^[a-z0-9-]+\.trycloudflare\.com$ ]]; then
    echo "https://${normalized}"
    return
  fi
  echo "${normalized}"
}


test_token_file_has_trycloudflare_url() {
  [[ -f "${TOKEN_FILE}" ]] || return 1
  grep -qE "${TUNNEL_URL_PATTERN}" "${TOKEN_FILE}"
}


test_token_file_has_expected_public_url() {
  local on_disk
  on_disk="$(token_file_public_url || true)"
  [[ -n "${on_disk}" ]] || return 1
  if [[ -n "${NAMED_PUBLIC_URL}" ]]; then
    [[ "${on_disk}" == "${NAMED_PUBLIC_URL}" ]]
    return
  fi
  test_token_file_has_trycloudflare_url
}


token_file_public_url() {
  if [[ ! -f "${TOKEN_FILE}" ]]; then
    return 1
  fi
  grep -E '^\s*publicBridgeUrl:\s*' "${TOKEN_FILE}" | tail -n 1 | sed -E 's/^\s*publicBridgeUrl:\s*//;s/\s*$//;s/\/$//'
}


bridge_token_file_path_from_api() {
  local response
  if ! response="$(curl -fsS --max-time 10 "http://127.0.0.1:${BRIDGE_PORT}/local/config" 2>/dev/null)"; then
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi
  python3 -c 'import json,sys
try:
    data=json.loads(sys.stdin.read())
    path=(data.get("tokenFilePath") or "").strip()
    if path:
        print(path)
except Exception:
    pass' <<< "${response}"
}


paths_same_token_sync_dir() {
  local left="$1"
  local right="$2"
  local norm_left norm_right
  [[ -n "${left}" && -n "${right}" ]] || return 1
  if command -v realpath >/dev/null 2>&1; then
    norm_left="$(realpath -m "${left}" 2>/dev/null || echo "${left}")"
    norm_right="$(realpath -m "${right}" 2>/dev/null || echo "${right}")"
  else
    norm_left="${left%/}"
    norm_right="${right%/}"
  fi
  [[ "${norm_left}" == "${norm_right}" ]]
}


invoke_bridge_token_directory() {
  local directory="$1"
  local payload response
  if ! command -v python3 >/dev/null 2>&1; then
    log_fail "需要 python3 以同步 Bridge token 目录"
    return 1
  fi
  payload="$(python3 -c 'import json,sys; print(json.dumps({"directory": sys.argv[1]}))' "${directory}")"
  if response="$(curl -fsS --max-time 30 -X POST "http://127.0.0.1:${BRIDGE_PORT}/local/token-directory" \
    -H "Content-Type: application/json; charset=utf-8" \
    -d "${payload}" 2>&1)"; then
    log_ok "Bridge token 目录已对齐: ${directory}"
    return 0
  fi
  log_fail "Bridge token-directory API 失败: ${response}"
  return 1
}


ensure_bridge_token_sync_dir() {
  local bridge_file bridge_dir
  bridge_file="$(bridge_token_file_path_from_api || true)"
  if [[ -z "${bridge_file}" ]]; then
    return 0
  fi
  bridge_dir="$(dirname "${bridge_file}")"
  if paths_same_token_sync_dir "${TOKEN_SYNC_DIR}" "${bridge_dir}"; then
    return 0
  fi
  log_step "Bridge token 目录 (${bridge_dir}) 与启动脚本 (${TOKEN_SYNC_DIR}) 不一致，正在对齐..."
  if invoke_bridge_token_directory "${TOKEN_SYNC_DIR}"; then
    bridge_file="$(bridge_token_file_path_from_api || true)"
    bridge_dir="$(dirname "${bridge_file}")"
    if paths_same_token_sync_dir "${TOKEN_SYNC_DIR}" "${bridge_dir}"; then
      return 0
    fi
  fi
  if [[ "${BRIDGE_OWNED}" -eq 1 ]] && [[ -n "${BRIDGE_PID}" ]] && kill -0 "${BRIDGE_PID}" 2>/dev/null; then
    log_step "对齐失败，重启本脚本启动的 Bridge..."
    kill "${BRIDGE_PID}" 2>/dev/null || true
    sleep 1
    BRIDGE_PID=""
    BRIDGE_OWNED=0
    start_bridge
    wait_bridge_ready || return 1
    invoke_bridge_token_directory "${TOKEN_SYNC_DIR}" || return 1
    return 0
  fi
  log_fail "Bridge 正由其他进程托管且 token 目录不一致。请先 ./shutdown.sh 再 ./run.sh"
  return 1
}


is_localhost_public_url() {
  local url="$1"
  [[ "${url}" =~ ^https?://127\.0\.0\.1 ]] || [[ "${url}" =~ ^https?://localhost([:/]|$) ]]
}


public_health_ok() {
  local url="$1"
  [[ -n "${url}" ]] || return 1
  is_localhost_public_url "${url}" && return 1
  curl -fsS --max-time 15 "${url}/health" 2>/dev/null | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'
}


wait_public_bridge_communication() {
  local url="$1"
  local max_wait="${2:-90}"
  local interval="${3:-5}"
  local attempt=0
  local elapsed=0
  while [[ "${elapsed}" -lt "${max_wait}" ]]; do
    if [[ "${SHUTTING_DOWN}" -eq 1 ]]; then
      return 1
    fi
    attempt=$((attempt + 1))
    if public_health_ok "${url}"; then
      if [[ "${attempt}" -gt 1 ]]; then
        log_ok "公网健康检查通过（第 ${attempt} 次）: ${url}/health"
      fi
      return 0
    fi
    if [[ "${attempt}" -eq 1 ]]; then
      echo "等待公网 Bridge 健康检查 ${url}/health（最多 ${max_wait}s）..."
    fi
    sleep "${interval}"
    elapsed=$((elapsed + interval))
  done
  return 1
}


start_bridge() {
  export BRIDGE_PUBLIC_URL="http://127.0.0.1:${BRIDGE_PORT}"
  export BRIDGE_PORT="${BRIDGE_PORT}"
  : >"${BRIDGE_LOG}"
  : >"${BRIDGE_ERR_LOG}"
  pnpm dev:bridge >>"${BRIDGE_LOG}" 2>>"${BRIDGE_ERR_LOG}" &
  BRIDGE_PID=$!
  BRIDGE_OWNED=1
  set_service_pid bridge "${BRIDGE_PID}"
  echo "Bridge PID: ${BRIDGE_PID}"
}


wait_bridge_ready() {
  local i
  for ((i = 0; i < 120; i++)); do
    if bridge_healthy; then
      return 0
    fi
    if [[ "${BRIDGE_OWNED}" -eq 1 ]] && ! kill -0 "${BRIDGE_PID}" 2>/dev/null; then
      log_fail "Bridge 进程已退出"
      tail -n 40 "${BRIDGE_LOG}" 2>/dev/null || true
      return 1
    fi
    sleep 1
  done
  log_fail "Bridge 在 120s 内未就绪"
  tail -n 40 "${BRIDGE_LOG}" 2>/dev/null || true
  return 1
}


start_web() {
  pnpm dev:web >/dev/null 2>&1 &
  WEB_PID=$!
  WEB_OWNED=1
  set_service_pid web "${WEB_PID}"
  echo "Web PID: ${WEB_PID}"
}


wait_web_ready() {
  local i url
  url="http://127.0.0.1:${WEB_PORT}/ChattingCursor/"
  for ((i = 0; i < 90; i++)); do
    if web_healthy; then
      return 0
    fi
    if [[ "${WEB_OWNED}" -eq 1 ]] && ! kill -0 "${WEB_PID}" 2>/dev/null; then
      log_fail "Web 进程已退出"
      return 1
    fi
    sleep 1
  done
  log_fail "Web 在 90s 内未就绪: ${url}"
  return 1
}


start_tunnel() {
  local cloudflared="$1"
  : >"${TUNNEL_LOG}"
  TUNNEL_LOG_OFFSET=0
  TUNNEL_URL_APPLIED=0
  DETECTED_TUNNEL_URL=""
  if [[ -n "${NAMED_TUNNEL_NAME}" ]]; then
    echo "cloudflared 命名隧道: ${NAMED_TUNNEL_NAME} -> ${NAMED_PUBLIC_URL}"
    "${cloudflared}" tunnel run "${NAMED_TUNNEL_NAME}" >>"${TUNNEL_LOG}" 2>&1 &
  else
    "${cloudflared}" tunnel --url "http://127.0.0.1:${BRIDGE_PORT}" >>"${TUNNEL_LOG}" 2>&1 &
  fi
  TUNNEL_PID=$!
  TUNNEL_OWNED=1
  set_service_pid cloudflared "${TUNNEL_PID}"
  echo "cloudflared PID: ${TUNNEL_PID} (log: ${TUNNEL_LOG})"
}


extract_trycloudflare_url_from_line() {
  local line="$1"
  local url
  url="$(echo "${line}" | grep -oE "${TUNNEL_URL_PATTERN}" | head -n 1 || true)"
  if [[ -z "${url}" ]]; then
    url="$(echo "${line}" | grep -oE "${TUNNEL_URL_HTTP_PATTERN}" | head -n 1 || true)"
    if [[ -n "${url}" ]]; then
      url="https://${url#http://}"
    fi
  fi
  if [[ -z "${url}" ]]; then
    url="$(echo "${line}" | grep -oE '[a-z0-9-]+\.trycloudflare\.com' | head -n 1 || true)"
    if [[ -n "${url}" ]]; then
      url="https://${url}"
    fi
  fi
  if [[ -n "${url}" ]]; then
    ensure_https_public_bridge_url "${url}"
  fi
}


set_public_bridge_url() {
  local url="$1"
  local force="${2:-0}"
  local normalized response on_disk
  if [[ "${TUNNEL_URL_APPLIED}" -eq 1 && "${force}" -eq 0 ]]; then
    return 0
  fi
  normalized="$(ensure_https_public_bridge_url "${url}")"
  if ! response="$(curl -fsS --max-time 30 -X POST "http://127.0.0.1:${BRIDGE_PORT}/local/public-bridge-url" \
    -H "Content-Type: application/json; charset=utf-8" \
    -d "{\"publicBridgeUrl\":\"${normalized}\"}" 2>&1)"; then
    log_fail "Bridge API 写入 publicBridgeUrl 失败: ${response}"
    return 1
  fi
  if command -v python3 >/dev/null 2>&1; then
    local bridge_token_path bridge_dir
    bridge_token_path="$(python3 -c 'import json,sys
try:
    data=json.loads(sys.argv[1])
    print((data.get("tokenFilePath") or "").strip())
except Exception:
    pass' "${response}")"
    if [[ -n "${bridge_token_path}" ]]; then
      bridge_dir="$(dirname "${bridge_token_path}")"
      if ! paths_same_token_sync_dir "${TOKEN_SYNC_DIR}" "${bridge_dir}"; then
        log_fail "Bridge 写入路径 (${bridge_token_path}) 与预期 (${TOKEN_FILE}) 不一致"
        return 1
      fi
    fi
  fi
  log_ok "Bridge 已轮换 token 并设置 publicBridgeUrl（见 token 文件）"
  if ! test_token_file_has_expected_public_url; then
    if [[ -n "${NAMED_PUBLIC_URL}" ]]; then
      log_fail "token 文件中 publicBridgeUrl 与命名隧道主机名不一致"
    else
      log_fail "token 文件中未找到 trycloudflare 公网 URL"
    fi
    return 1
  fi
  on_disk="$(token_file_public_url || true)"
  if [[ "${on_disk}" != "${normalized}" ]]; then
    log_fail "token 文件 URL 与隧道 URL 不一致: ${on_disk}"
    return 1
  fi
  log_ok "token 文件已包含公网 URL: ${on_disk}"
  restore_service_pids_after_bridge_token_write
  TUNNEL_URL_APPLIED=1
  echo ""
  echo "----------------------------------------"
  echo "Token 文件: ${TOKEN_FILE}"
  echo "publicBridgeUrl: ${on_disk}"
  echo "手机配置: GitHub Pages -> Local -> Config"
  echo "  Bridge URL = ${on_disk}"
  echo "----------------------------------------"
  echo ""
  return 0
}


invoke_tunnel_line() {
  local line="$1"
  local url
  if [[ "${TUNNEL_URL_APPLIED}" -eq 1 || -z "${line// }" ]]; then
    return 0
  fi
  if [[ -n "${NAMED_PUBLIC_URL}" ]]; then
    return 0
  fi
  url="$(extract_trycloudflare_url_from_line "${line}" || true)"
  [[ -n "${url}" ]] || return 0
  if [[ "${DETECTED_TUNNEL_URL}" == "${url}" ]]; then
    return 0
  fi
  DETECTED_TUNNEL_URL="${url}"
  log_ok "检测到 cloudflared 隧道 URL: ${url}"
  set_public_bridge_url "${url}" 0
}


read_tunnel_log_new_lines() {
  local size new_bytes chunk
  if [[ ! -f "${TUNNEL_LOG}" ]]; then
    return 0
  fi
  size="$(wc -c < "${TUNNEL_LOG}" 2>/dev/null | tr -d ' ')"
  size="${size:-0}"
  if [[ "${size}" -le "${TUNNEL_LOG_OFFSET}" ]]; then
    return 0
  fi
  new_bytes=$((size - TUNNEL_LOG_OFFSET))
  chunk="$(tail -c "${new_bytes}" "${TUNNEL_LOG}" 2>/dev/null || true)"
  TUNNEL_LOG_OFFSET="${size}"
  while IFS= read -r line || [[ -n "${line}" ]]; do
    invoke_tunnel_line "${line}"
  done <<< "${chunk}"
}


apply_named_tunnel_url() {
  DETECTED_TUNNEL_URL="${NAMED_PUBLIC_URL}"
  set_public_bridge_url "${NAMED_PUBLIC_URL}" 1
}


restart_tunnel_process() {
  local cloudflared="$1"
  if [[ -n "${TUNNEL_PID}" ]] && kill -0 "${TUNNEL_PID}" 2>/dev/null; then
    kill "${TUNNEL_PID}" 2>/dev/null || true
    sleep 1
  fi
  TUNNEL_PID=""
  TUNNEL_URL_APPLIED=0
  DETECTED_TUNNEL_URL=""
  start_tunnel "${cloudflared}"
}


invoke_bridge_regenerate_token() {
  local attempt response
  for attempt in $(seq 1 6); do
    if response="$(curl -fsS --max-time 30 -X POST "http://127.0.0.1:${BRIDGE_PORT}/local/regenerate-token" \
      -H "Content-Type: application/json; charset=utf-8" 2>&1)"; then
      log_ok "Bridge 已重新生成当日 token"
      restore_service_pids_after_bridge_token_write
      return 0
    fi
    if [[ "${attempt}" -lt 6 ]]; then
      echo "Bridge regenerate-token 第 ${attempt} 次失败，3s 后重试..."
      sleep 3
    else
      log_fail "Bridge 重新生成 token 失败: ${response}"
      return 1
    fi
  done
  return 1
}


invoke_tunnel_recovery() {
  local reason="$1"
  local cloudflared="$2"
  local on_disk
  echo "[RECOVERY START] 仅重启 cloudflared — 原因: ${reason}"
  restart_tunnel_process "${cloudflared}"
  local tick
  for ((tick = 0; tick < 180; tick++)); do
    read_tunnel_log_new_lines
    if [[ -n "${DETECTED_TUNNEL_URL}" && "${TUNNEL_URL_APPLIED}" -eq 0 ]]; then
      set_public_bridge_url "${DETECTED_TUNNEL_URL}" 1 || true
    fi
    if [[ "${TUNNEL_URL_APPLIED}" -eq 1 ]]; then
      break
    fi
    if [[ "${TUNNEL_OWNED}" -eq 1 ]] && ! kill -0 "${TUNNEL_PID}" 2>/dev/null; then
      log_fail "恢复时 cloudflared 已退出"
      return 1
    fi
    sleep 0.5
  done
  if [[ "${TUNNEL_URL_APPLIED}" -ne 1 ]]; then
    log_fail "隧道恢复后未在时限内写入 trycloudflare URL"
    return 1
  fi
  if ! invoke_bridge_regenerate_token; then
    return 1
  fi
  on_disk="$(token_file_public_url || true)"
  if [[ -z "${on_disk}" ]] || ! public_health_ok "${on_disk}"; then
    log_fail "[RECOVERY FAILED] 新 URL 不可达: ${on_disk}/health"
    return 1
  fi
  log_ok "[RECOVERY COMPLETE] 新 URL: ${on_disk}"
  return 0
}


stop_children() {
  for pid in "${TUNNEL_PID}" "${WEB_PID}" "${BRIDGE_PID}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
    fi
  done
}


on_signal() {
  SHUTTING_DOWN=1
  echo ""
  echo "正在停止 Bridge 与隧道..."
  stop_children
  exit 0
}

trap on_signal INT TERM

echo "=== ChattingCursor 启动 (Linux/macOS) ==="
echo "Token 目录: ${TOKEN_SYNC_DIR}"
echo "Token 文件: ${TOKEN_FILE}"
echo "停止: Ctrl+C"
echo ""

ensure_project_ready

start_chrome

CLOUDFLARED="$(resolve_cloudflared || true)"
if [[ -z "${CLOUDFLARED}" ]]; then
  log_fail "未找到 cloudflared。请先运行 ./install.sh"
  exit 1
fi
log_ok "cloudflared: ${CLOUDFLARED}"

read_named_tunnel_config || true

initialize_fresh_startup_pid_tracking

if port_in_use "${BRIDGE_PORT}" && ! bridge_healthy; then
  log_fail "端口 ${BRIDGE_PORT} 被占用但 Bridge 不健康。可先运行 ./shutdown.sh 后重试。"
  exit 2
fi

if ! bridge_healthy; then
  log_step "启动 Bridge (端口 ${BRIDGE_PORT})..."
  start_bridge
  wait_bridge_ready || exit 1
fi
log_ok "Bridge 本地健康: http://127.0.0.1:${BRIDGE_PORT}/health"
ensure_bridge_token_sync_dir || exit 1
restore_service_pids_after_bridge_token_write

if [[ "${WITH_WEB}" -eq 1 ]]; then
  if web_healthy; then
    log_ok "Web 已在运行: http://127.0.0.1:${WEB_PORT}/ChattingCursor/"
  elif port_in_use "${WEB_PORT}"; then
    log_fail "端口 ${WEB_PORT} 被占用但 Web 不健康"
    exit 1
  else
    log_step "启动 Web (端口 ${WEB_PORT})..."
    start_web
    wait_web_ready || exit 1
    log_ok "Web: http://127.0.0.1:${WEB_PORT}/ChattingCursor/"
  fi
fi

if [[ -n "${NAMED_PUBLIC_URL}" ]]; then
  log_step "启动 cloudflared 命名隧道 (${NAMED_TUNNEL_NAME})..."
else
  log_step "启动 cloudflared 快速隧道..."
fi
start_tunnel "${CLOUDFLARED}"

if [[ -n "${NAMED_PUBLIC_URL}" ]]; then
  echo "应用稳定公网 URL: ${NAMED_PUBLIC_URL}"
  apply_named_tunnel_url || true
else
  echo "等待隧道 URL（最多 90s）..."
fi

startup_tunnel_ready=0
tunnel_wait_seconds=90
for ((tick = 0; tick < tunnel_wait_seconds * 2; tick++)); do
  if [[ "${SHUTTING_DOWN}" -eq 1 ]]; then
    break
  fi
  sleep 0.5
  read_tunnel_log_new_lines
  if [[ -n "${DETECTED_TUNNEL_URL}" && "${TUNNEL_URL_APPLIED}" -eq 0 ]]; then
    set_public_bridge_url "${DETECTED_TUNNEL_URL}" 0
  fi
  if [[ "${TUNNEL_URL_APPLIED}" -eq 1 ]]; then
    public_url="$(token_file_public_url || true)"
    if [[ -n "${public_url}" ]] && public_health_ok "${public_url}"; then
      log_ok "公网健康检查通过: ${public_url}/health"
      startup_tunnel_ready=1
      break
    fi
    if [[ "${STARTUP_PUBLIC_HEALTH_WAIT_DONE}" -eq 0 ]]; then
      STARTUP_PUBLIC_HEALTH_WAIT_DONE=1
      if [[ -n "${public_url}" ]] && wait_public_bridge_communication "${public_url}" 75 5; then
        log_ok "公网健康检查通过: ${public_url}/health"
        startup_tunnel_ready=1
        break
      fi
    fi
    if [[ "${STARTUP_TUNNEL_RECOVERY_ATTEMPTED}" -eq 0 ]]; then
      STARTUP_TUNNEL_RECOVERY_ATTEMPTED=1
      health_reason="启动公网健康检查失败: ${public_url}/health"
      if [[ -z "${public_url}" ]]; then
        health_reason="隧道 URL 已写入但 token 文件缺少 publicBridgeUrl"
      fi
      log_fail "${health_reason}；尝试仅重启隧道（一次）..."
      if invoke_tunnel_recovery "${health_reason}" "${CLOUDFLARED}"; then
        public_url="$(token_file_public_url || true)"
        if [[ -n "${public_url}" ]] && wait_public_bridge_communication "${public_url}" 60 5; then
          log_ok "恢复后公网健康检查通过: ${public_url}/health"
          startup_tunnel_ready=1
          break
        fi
      fi
    fi
    continue
  fi
  if [[ "${TUNNEL_OWNED}" -eq 1 ]] && ! kill -0 "${TUNNEL_PID}" 2>/dev/null; then
    read_tunnel_log_new_lines
    if [[ "${STARTUP_TUNNEL_RECOVERY_ATTEMPTED}" -eq 0 ]]; then
      STARTUP_TUNNEL_RECOVERY_ATTEMPTED=1
      invoke_tunnel_recovery "cloudflared 已退出" "${CLOUDFLARED}" || break
      continue
    fi
    log_fail "cloudflared 已退出。日志: ${TUNNEL_LOG}"
    exit 1
  fi
  if [[ "${BRIDGE_OWNED}" -eq 1 ]] && ! kill -0 "${BRIDGE_PID}" 2>/dev/null && ! bridge_healthy; then
    log_fail "Bridge 进程已退出"
    exit 1
  fi
done

if [[ "${startup_tunnel_ready}" -ne 1 ]]; then
  read_tunnel_log_new_lines
  if [[ "${TUNNEL_URL_APPLIED}" -ne 1 ]]; then
    if [[ -n "${NAMED_PUBLIC_URL}" ]]; then
      log_fail "命名隧道未在 ${tunnel_wait_seconds}s 内写入 publicBridgeUrl。日志: ${TUNNEL_LOG}"
    else
      log_fail "未在 ${tunnel_wait_seconds}s 内检测到 trycloudflare URL。日志: ${TUNNEL_LOG}"
    fi
    exit 1
  fi
  failed_url="$(token_file_public_url || true)"
  log_fail "公网健康尚未确认 (${failed_url}/health)。将进入监控循环并继续重试。"
fi

log_ok "Startup flow complete. 启动完成。服务运行中（Ctrl+C 停止）。"
HEALTH_CHECK_INTERVAL=300
seconds_since_health_check=0
while [[ "${SHUTTING_DOWN}" -eq 0 ]]; do
  sleep 0.5
  read_tunnel_log_new_lines
  seconds_since_health_check=$((seconds_since_health_check + 1))
  if [[ "${BRIDGE_OWNED}" -eq 1 ]] && ! kill -0 "${BRIDGE_PID}" 2>/dev/null && ! bridge_healthy; then
    log_fail "Bridge 进程已退出"
    exit 1
  fi
  if [[ "${TUNNEL_OWNED}" -eq 1 ]] && ! kill -0 "${TUNNEL_PID}" 2>/dev/null; then
    read_tunnel_log_new_lines
    invoke_tunnel_recovery "cloudflared 已退出" "${CLOUDFLARED}" || log_fail "隧道恢复失败，将在下次检查时重试"
    seconds_since_health_check=0
    continue
  fi
  if [[ "${seconds_since_health_check}" -ge $((HEALTH_CHECK_INTERVAL * 2)) ]]; then
    seconds_since_health_check=0
    public_url="$(token_file_public_url || true)"
    if [[ -n "${public_url}" ]] && ! public_health_ok "${public_url}"; then
      log_fail "公网健康检查失败 (${public_url}/health)；启动隧道恢复..."
      invoke_tunnel_recovery "公网健康检查失败: ${public_url}/health" "${CLOUDFLARED}" || log_fail "隧道恢复失败"
    fi
  fi
done
