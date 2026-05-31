#!/usr/bin/env bash
# 解析 token 同步目录：参数/环境变量 > ~/.chattingcursor/config.json > 默认 ~/.chattingcursor

expand_user_path() {
  local raw="${1:-}"
  if [[ -z "${raw}" ]]; then
    return 1
  fi
  if [[ "${raw}" == "~" ]]; then
    echo "${HOME}"
    return 0
  fi
  if [[ "${raw}" == "~/"* ]]; then
    echo "${HOME}/${raw:2}"
    return 0
  fi
  if [[ "${raw}" == "~"* ]]; then
    echo "${raw}"
    return 0
  fi
  echo "${raw}"
}


# rclone 远程写法 onedrive:... 转为本机可写目录（OneDrive 同步文件夹或 rclone 挂载点）
resolve_onedrive_remote_path() {
  local remote="$1"
  local rel="${remote#onedrive:}"
  local rel_lc="${rel,,}"
  rel="${rel#/}"
  rel_lc="${rel_lc#/}"
  if [[ "${rel_lc}" == onedrive/* ]]; then
    rel="${rel#*/}"
    rel="${rel#OneDrive/}"
    rel="${rel#onedrive/}"
  fi
  rel="$(expand_user_path "${rel}")"
  if [[ "${rel}" == /* ]]; then
    if [[ -d "${rel}" ]]; then
      echo "${rel}"
      return 0
    fi
    echo "[FAIL] onedrive: 路径在本机不存在或不可访问: ${rel}（请确认 OneDrive/rclone 已同步或挂载）" >&2
    return 1
  fi
  local candidate
  for candidate in \
    "${HOME}/${rel}" \
    "${HOME}/OneDrive/${rel}" \
    "${HOME}/onedrive/${rel}" \
    "${HOME}/OneDrive - Personal/${rel}" \
    "${HOME}/mnt/onedrive/${rel}" \
    "${HOME}/rclone/onedrive/${rel}" \
    "${HOME}/.OneDrive/${rel}" \
    "/mnt/onedrive/${rel}"; do
    if [[ -d "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  echo "[FAIL] 无法将 onedrive: 解析到本机目录（remote=${remote}）。" >&2
  echo "       请改用已存在的本机路径，例如 ~/OneDrive/${rel} 或 rclone 挂载点。" >&2
  return 1
}


normalize_token_sync_dir() {
  local raw="${1:-}"
  local trimmed expanded
  trimmed="$(echo "${raw}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ -z "${trimmed}" ]]; then
    return 1
  fi
  if [[ "${trimmed}" =~ ^[Oo][Nn][Ee][Dd][Rr][Ii][Vv][Ee]: ]]; then
    resolve_onedrive_remote_path "${trimmed}"
    return $?
  fi
  expanded="$(expand_user_path "${trimmed}")"
  if command -v realpath >/dev/null 2>&1 && [[ -e "${expanded}" ]]; then
    realpath -m "${expanded}" 2>/dev/null || echo "${expanded}"
    return 0
  fi
  echo "${expanded}"
}


# 返回目录来源：default | override | env | config
resolve_token_sync_dir_source() {
  local override="${1:-}"
  local trimmed from_file config_path
  trimmed="$(echo "${override}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ -n "${trimmed}" ]]; then
    echo "override"
    return 0
  fi
  if [[ -n "${CHATTINGCURSOR_TOKEN_SYNC_DIR:-}" ]]; then
    echo "env"
    return 0
  fi
  config_path="$(chattingcursor_home_dir)/config.json"
  if [[ -f "${config_path}" ]] && command -v python3 >/dev/null 2>&1; then
    from_file="$(python3 -c 'import json,sys
path=sys.argv[1]
try:
    data=json.load(open(path,encoding="utf-8"))
    value=(data.get("tokenSyncDir") or "").strip()
    if value:
        print(value)
except Exception:
    pass' "${config_path}")"
    if [[ -n "${from_file}" ]]; then
      echo "config"
      return 0
    fi
  fi
  echo "default"
}


resolve_token_sync_dir() {
  local override="${1:-}"
  local resolved=""
  if [[ -n "$(echo "${override}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')" ]]; then
    normalize_token_sync_dir "${override}"
    return $?
  elif [[ -n "${CHATTINGCURSOR_TOKEN_SYNC_DIR:-}" ]]; then
    resolved="${CHATTINGCURSOR_TOKEN_SYNC_DIR}"
  else
    local config_path from_file
    config_path="$(chattingcursor_home_dir)/config.json"
    if [[ -f "${config_path}" ]] && command -v python3 >/dev/null 2>&1; then
      from_file="$(python3 -c 'import json,sys
path=sys.argv[1]
try:
    data=json.load(open(path,encoding="utf-8"))
    value=(data.get("tokenSyncDir") or "").strip()
    if value:
        print(value)
except Exception:
    pass' "${config_path}")"
      if [[ -n "${from_file}" ]]; then
        resolved="${from_file}"
      fi
    fi
    if [[ -z "${resolved}" ]]; then
      resolved="$(chattingcursor_home_dir)"
    fi
  fi
  normalize_token_sync_dir "${resolved}"
}


# 默认目录可创建；用户指定目录仅校验存在、为目录、可写
ensure_token_sync_dir_ready() {
  local dir="$1"
  local source="${2:-default}"
  local default_dir probe norm_dir norm_default
  default_dir="$(chattingcursor_home_dir)"
  if command -v realpath >/dev/null 2>&1; then
    norm_dir="$(realpath -m "${dir}" 2>/dev/null || echo "${dir}")"
    norm_default="$(realpath -m "${default_dir}" 2>/dev/null || echo "${default_dir}")"
  else
    norm_dir="${dir%/}"
    norm_default="${default_dir%/}"
  fi
  if [[ "${norm_dir}" == "${norm_default}" ]] || [[ "${source}" == "default" ]]; then
    mkdir -p "${dir}"
    return 0
  fi
  if [[ ! -e "${dir}" ]]; then
    echo "[FAIL] Token 同步目录不存在: ${dir}" >&2
    echo "       用户指定的云目录须先在本机存在且可写，脚本不会自动创建。" >&2
    echo "       来源: ${source}；请检查 config.json 的 tokenSyncDir 或 CHATTINGCURSOR_TOKEN_SYNC_DIR。" >&2
    return 1
  fi
  if [[ ! -d "${dir}" ]]; then
    echo "[FAIL] Token 同步路径不是目录: ${dir}" >&2
    return 1
  fi
  probe="${dir}/.chattingcursor-write-test.$$"
  if ! ( : >"${probe}" ) 2>/dev/null; then
    echo "[FAIL] Token 同步目录不可写: ${dir}" >&2
    echo "       请确认 OneDrive/rclone 已挂载且该文件夹有写权限。" >&2
    return 1
  fi
  rm -f "${probe}" 2>/dev/null || true
  return 0
}
