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
TOKEN_SYNC_DIR="$(resolve_token_sync_dir "${TOKEN_SYNC_DIR_OVERRIDE}")"
TOKEN_FILE="${TOKEN_SYNC_DIR}/chattingcursor-token.txt"
TUNNEL_URL_PATTERN='https://[a-z0-9-]+\.trycloudflare\.com'

BRIDGE_PID=""
WEB_PID=""
TUNNEL_PID=""
BRIDGE_OWNED=0
WEB_OWNED=0
TUNNEL_OWNED=0
NAMED_TUNNEL_NAME=""
NAMED_PUBLIC_URL=""
SHUTTING_DOWN=0

mkdir -p "${TOKEN_SYNC_DIR}"

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


start_bridge() {
  export CHATTINGCURSOR_TOKEN_SYNC_DIR="${TOKEN_SYNC_DIR}"
  export BRIDGE_PUBLIC_URL="http://127.0.0.1:${BRIDGE_PORT}"
  export BRIDGE_PORT="${BRIDGE_PORT}"
  : >"${BRIDGE_LOG}"
  : >"${BRIDGE_ERR_LOG}"
  pnpm dev:bridge >>"${BRIDGE_LOG}" 2>>"${BRIDGE_ERR_LOG}" &
  BRIDGE_PID=$!
  BRIDGE_OWNED=1
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
  if [[ -n "${NAMED_TUNNEL_NAME}" ]]; then
    echo "cloudflared 命名隧道: ${NAMED_TUNNEL_NAME} -> ${NAMED_PUBLIC_URL}"
    "${cloudflared}" tunnel run "${NAMED_TUNNEL_NAME}" >>"${TUNNEL_LOG}" 2>&1 &
  else
    "${cloudflared}" tunnel --url "http://127.0.0.1:${BRIDGE_PORT}" >>"${TUNNEL_LOG}" 2>&1 &
  fi
  TUNNEL_PID=$!
  TUNNEL_OWNED=1
  echo "cloudflared PID: ${TUNNEL_PID} (log: ${TUNNEL_LOG})"
}


detect_tunnel_url_from_log() {
  if [[ -n "${NAMED_PUBLIC_URL}" ]]; then
    echo "${NAMED_PUBLIC_URL}"
    return
  fi
  if [[ ! -f "${TUNNEL_LOG}" ]]; then
    return 1
  fi
  grep -oE "${TUNNEL_URL_PATTERN}" "${TUNNEL_LOG}" | tail -n 1
}


set_public_bridge_url() {
  local url="$1"
  url="${url%/}"
  if [[ "${url}" == http://* ]]; then
    url="https://${url#http://}"
  fi
  curl -fsS -X POST "http://127.0.0.1:${BRIDGE_PORT}/local/public-bridge-url" \
    -H "Content-Type: application/json" \
    -d "{\"publicBridgeUrl\":\"${url}\"}" >/dev/null
}


token_file_public_url() {
  if [[ ! -f "${TOKEN_FILE}" ]]; then
    return 1
  fi
  grep -E '^\s*publicBridgeUrl:\s*' "${TOKEN_FILE}" | tail -n 1 | sed -E 's/^\s*publicBridgeUrl:\s*//;s/\s*$//;s/\/$//'
}


public_health_ok() {
  local url="$1"
  [[ -n "${url}" ]] || return 1
  curl -fsS "${url}/health" 2>/dev/null | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'
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

CLOUDFLARED="$(resolve_cloudflared || true)"
if [[ -z "${CLOUDFLARED}" ]]; then
  log_fail "未找到 cloudflared。请先运行 ./install.sh"
  exit 1
fi
log_ok "cloudflared: ${CLOUDFLARED}"

read_named_tunnel_config || true

if port_in_use "${BRIDGE_PORT}" && ! bridge_healthy; then
  log_fail "端口 ${BRIDGE_PORT} 被占用但 Bridge 不健康。可先结束占用进程后重试。"
  exit 2
fi

if ! bridge_healthy; then
  log_step "启动 Bridge (端口 ${BRIDGE_PORT})..."
  start_bridge
  wait_bridge_ready || exit 1
fi
log_ok "Bridge: http://127.0.0.1:${BRIDGE_PORT}/health"

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
  log_step "启动 cloudflared 命名隧道..."
  start_tunnel "${CLOUDFLARED}"
  sleep 2
  set_public_bridge_url "${NAMED_PUBLIC_URL}" || log_fail "写入 publicBridgeUrl 失败"
else
  log_step "启动 cloudflared 快速隧道..."
  start_tunnel "${CLOUDFLARED}"
fi

startup_ok=0
for ((tick = 0; tick < 180; tick++)); do
  if [[ "${SHUTTING_DOWN}" -eq 1 ]]; then
    break
  fi
  detected="$(detect_tunnel_url_from_log || true)"
  if [[ -n "${detected}" ]]; then
    set_public_bridge_url "${detected}" || true
  fi
  on_disk="$(token_file_public_url || true)"
  if [[ -n "${on_disk}" ]] && public_health_ok "${on_disk}"; then
    log_ok "公网健康检查通过: ${on_disk}/health"
    echo ""
    echo "Token 文件: ${TOKEN_FILE}"
    echo "publicBridgeUrl: ${on_disk}"
    startup_ok=1
    break
  fi
  if [[ "${TUNNEL_OWNED}" -eq 1 ]] && ! kill -0 "${TUNNEL_PID}" 2>/dev/null; then
    log_fail "cloudflared 已退出，请查看日志: ${TUNNEL_LOG}"
    exit 1
  fi
  sleep 1
done

if [[ "${startup_ok}" -ne 1 ]]; then
  log_fail "未在时限内完成隧道与公网健康检查。日志: ${TUNNEL_LOG}"
  exit 1
fi

log_ok "启动完成。服务运行中（Ctrl+C 停止）。"
while [[ "${SHUTTING_DOWN}" -eq 0 ]]; do
  if [[ "${BRIDGE_OWNED}" -eq 1 ]] && ! kill -0 "${BRIDGE_PID}" 2>/dev/null; then
    log_fail "Bridge 进程已退出"
    exit 1
  fi
  if [[ "${TUNNEL_OWNED}" -eq 1 ]] && ! kill -0 "${TUNNEL_PID}" 2>/dev/null; then
    log_fail "cloudflared 已退出"
    exit 1
  fi
  sleep 2
done
