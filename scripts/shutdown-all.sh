#!/usr/bin/env bash
# 停止 ChattingCursor 后台服务（Bridge、cloudflared、Web、run-all 等）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sh/common.sh
source "${SCRIPT_DIR}/sh/common.sh"
# shellcheck source=sh/resolve-token-sync-dir.sh
source "${SCRIPT_DIR}/sh/resolve-token-sync-dir.sh"
# shellcheck source=sh/token-file-pids.sh
source "${SCRIPT_DIR}/sh/token-file-pids.sh"
# shellcheck source=sh/token-file-name.sh
source "${SCRIPT_DIR}/sh/token-file-name.sh"

BRIDGE_PORT=4321
WEB_PORT=43210
PORT_WAIT_SECONDS=30
SKIP_WEB=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -SkipWeb|--skip-web) SKIP_WEB=1 ;;
    -BridgePort) BRIDGE_PORT="${2:-4321}"; shift ;;
    -WebPort) WEB_PORT="${2:-43210}"; shift ;;
    -PortWaitSeconds) PORT_WAIT_SECONDS="${2:-30}"; shift ;;
    *) ;;
  esac
  shift
done

ROOT="$(chattingcursor_repo_root)"
TOKEN_SYNC_DIR="$(resolve_token_sync_dir "")"
TOKEN_FILE="$(chattingcursor_token_file_path "${TOKEN_SYNC_DIR}")"
stop_process_safe() {
  local pid="$1"
  local label="$2"
  local child
  if [[ -z "${pid}" || "${pid}" -le 4 ]]; then
    return 1
  fi
  if ! kill -0 "${pid}" 2>/dev/null; then
    return 1
  fi
  kill -TERM "${pid}" 2>/dev/null || true
  sleep 0.5
  if kill -0 "${pid}" 2>/dev/null; then
    kill -KILL "${pid}" 2>/dev/null || true
  fi
  if command -v pgrep >/dev/null 2>&1; then
    while read -r child; do
      [[ -n "${child}" ]] || continue
      kill -KILL "${child}" 2>/dev/null || true
    done < <(pgrep -P "${pid}" 2>/dev/null || true)
  fi
  echo "  已停止 ${label} (PID ${pid})"
  return 0
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


listener_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -t -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true
    return
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep ":${port} " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u
  fi
}


cmdline_matches_project() {
  local pid="$1"
  local cmd
  if [[ ! -r "/proc/${pid}/cmdline" ]]; then
    return 1
  fi
  cmd="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
  [[ "${cmd}" == *"${ROOT}"* ]]
}


is_bridge_cmdline() {
  local cmd="$1"
  [[ "${cmd}" == *"${ROOT}"* ]] && [[ "${cmd}" =~ dev:bridge|@chatting-cursor/bridge|apps/bridge|tsx.*src/index\.ts ]]
}


is_web_cmdline() {
  local cmd="$1"
  [[ "${cmd}" == *"${ROOT}"* ]] && [[ "${cmd}" =~ dev:web|@chatting-cursor/web|apps/web|vite ]]
}


is_cloudflared_cmdline() {
  local cmd="$1"
  local lower
  lower="$(echo "${cmd}" | tr '[:upper:]' '[:lower:]')"
  [[ "${lower}" == *cloudflared* && "${lower}" == *tunnel* ]] || return 1
  [[ "${cmd}" == *"127.0.0.1:${BRIDGE_PORT}"* || "${cmd}" == *":${BRIDGE_PORT}"* || "${cmd}" == *"${ROOT}"* ]]
}


is_run_all_cmdline() {
  local cmd="$1"
  [[ "${cmd}" == *run-all.sh* || "${cmd}" == *run-all.ps1* ]] && [[ "${cmd}" == *"${ROOT}"* ]]
}


collect_candidate_pids() {
  local -n out_ref="$1"
  local pid cmd name
  if [[ -d /proc ]]; then
    for pid_path in /proc/[0-9]*; do
      pid="${pid_path##*/}"
      [[ "${pid}" -gt 4 ]] || continue
      cmd="$(tr '\0' ' ' < "${pid_path}/cmdline" 2>/dev/null || true)"
      [[ -n "${cmd}" ]] || continue
      if is_bridge_cmdline "${cmd}"; then
        out_ref["${pid}"]=bridge
      fi
      if is_web_cmdline "${cmd}"; then
        out_ref["${pid}"]=web
      fi
      if is_cloudflared_cmdline "${cmd}"; then
        out_ref["${pid}"]=cloudflared
      fi
      if is_run_all_cmdline "${cmd}"; then
        out_ref["${pid}"]=run-all
      fi
    done
  fi
}


clear_port_listeners() {
  local port="$1"
  local max_wait="$2"
  local elapsed=0
  local pid cmd
  while [[ "${elapsed}" -lt "${max_wait}" ]]; do
    if ! port_in_use "${port}"; then
      return 0
    fi
    while read -r pid; do
      [[ -n "${pid}" ]] || continue
      if [[ -r "/proc/${pid}/cmdline" ]]; then
        cmd="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
        if cmdline_matches_project "${pid}" || is_bridge_cmdline "${cmd}" || is_web_cmdline "${cmd}"; then
          stop_process_safe "${pid}" "端口 ${port} 监听进程" || true
        fi
      else
        stop_process_safe "${pid}" "端口 ${port} 监听进程" || true
      fi
    done < <(listener_pids "${port}")
    sleep 0.5
    elapsed=$((elapsed + 1))
  done
  ! port_in_use "${port}"
}


echo "=== ChattingCursor 关闭 ==="
echo "项目根目录: ${ROOT}"
echo "Token 文件: ${TOKEN_FILE}"
echo ""

declare -A CANDIDATE_PIDS=()
declare -A TOKEN_PID_MAP=()

while read -r key pid; do
  [[ -n "${key}" && -n "${pid}" ]] && TOKEN_PID_MAP["${key}"]="${pid}"
done < <(get_token_file_pid_map "${TOKEN_FILE}")

if [[ ${#TOKEN_PID_MAP[@]} -gt 0 ]]; then
  log_step "根据 token 文件中的 pid.* 停止进程..."
  for key in "${MANAGED_PID_KEYS[@]}"; do
    pid="${TOKEN_PID_MAP[${key}]:-}"
    [[ -n "${pid}" && "${pid}" -gt 4 ]] || continue
    stop_process_safe "${pid}" "pid.${key}" || true
  done
  sleep 0.5
fi

collect_candidate_pids CANDIDATE_PIDS

for pid in $(listener_pids "${BRIDGE_PORT}"); do
  if [[ -r "/proc/${pid}/cmdline" ]]; then
    cmd="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
    if is_bridge_cmdline "${cmd}"; then
      CANDIDATE_PIDS["${pid}"]=bridge
    fi
  fi
done

if [[ "${SKIP_WEB}" -eq 0 ]]; then
  for pid in $(listener_pids "${WEB_PORT}"); do
    if [[ -r "/proc/${pid}/cmdline" ]]; then
      cmd="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
      if is_web_cmdline "${cmd}"; then
        CANDIDATE_PIDS["${pid}"]=web
      fi
    fi
  done
fi

log_step "停止 Bridge (端口 ${BRIDGE_PORT})..."
stopped_bridge=0
for pid in "${!CANDIDATE_PIDS[@]}"; do
  if [[ "${CANDIDATE_PIDS[${pid}]}" == "bridge" ]]; then
    stop_process_safe "${pid}" "Bridge" && stopped_bridge=1 || true
  fi
done
[[ "${stopped_bridge}" -eq 1 ]] && echo "Bridge 已停止。"

log_step "停止 cloudflared 隧道..."
stopped_cloud=0
for pid in "${!CANDIDATE_PIDS[@]}"; do
  if [[ "${CANDIDATE_PIDS[${pid}]}" == "cloudflared" ]]; then
    stop_process_safe "${pid}" "cloudflared" && stopped_cloud=1 || true
  fi
done
[[ "${stopped_cloud}" -eq 1 ]] && echo "cloudflared 已停止。"

if [[ "${SKIP_WEB}" -eq 0 ]]; then
  log_step "停止 Web / Vite (端口 ${WEB_PORT})..."
  stopped_web=0
  for pid in "${!CANDIDATE_PIDS[@]}"; do
    if [[ "${CANDIDATE_PIDS[${pid}]}" == "web" ]]; then
      stop_process_safe "${pid}" "Web" && stopped_web=1 || true
    fi
  done
  [[ "${stopped_web}" -eq 1 ]] && echo "Web 已停止。"
fi

for pid in "${!CANDIDATE_PIDS[@]}"; do
  if [[ "${CANDIDATE_PIDS[${pid}]}" == "run-all" ]]; then
    stop_process_safe "${pid}" "run-all" || true
  fi
done

pkill -f "${ROOT}.*dev:bridge" 2>/dev/null || true
pkill -f "${ROOT}.*dev:web" 2>/dev/null || true
pkill -f "cloudflared tunnel.*127.0.0.1:${BRIDGE_PORT}" 2>/dev/null || true
pkill -f "cloudflared tunnel --url http://127.0.0.1:${BRIDGE_PORT}" 2>/dev/null || true

log_step "释放端口（最多 ${PORT_WAIT_SECONDS}s）..."
ports_ok=1
if ! clear_port_listeners "${BRIDGE_PORT}" "${PORT_WAIT_SECONDS}"; then
  log_fail "端口 ${BRIDGE_PORT} (Bridge) 仍被占用"
  ports_ok=0
else
  log_ok "端口 ${BRIDGE_PORT} (Bridge) 已释放"
fi
if [[ "${SKIP_WEB}" -eq 0 ]]; then
  if ! clear_port_listeners "${WEB_PORT}" "${PORT_WAIT_SECONDS}"; then
    log_fail "端口 ${WEB_PORT} (Web) 仍被占用"
    ports_ok=0
  else
    log_ok "端口 ${WEB_PORT} (Web) 已释放"
  fi
fi

remaining_cloud="$(pgrep -af cloudflared 2>/dev/null | grep -E "tunnel|127\.0\.0\.1:${BRIDGE_PORT}" | awk '{print $1}' || true)"
if [[ -n "${remaining_cloud}" ]]; then
  while read -r pid; do
    [[ -n "${pid}" ]] && stop_process_safe "${pid}" "cloudflared (重试)" || true
  done <<< "${remaining_cloud}"
fi

if [[ "${ports_ok}" -ne 1 ]]; then
  log_fail "关闭未完成。请释放上述端口/进程后重新运行 run-all。"
  exit 1
fi

log_ok "已检查的端口与 cloudflared 均已停止。"
clear_token_file_pid_section "${TOKEN_FILE}"
echo ""
echo "关闭完成。可重新运行 ./run.sh 或 scripts/run-all.sh"
echo ""
exit 0
