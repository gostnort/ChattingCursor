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


# rclone 远程写法 onedrive:... 转为本机可写目录（OneDrive 同步文件夹）
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
    echo "${rel}"
    return 0
  fi
  local candidate
  for candidate in \
    "${HOME}/${rel}" \
    "${HOME}/OneDrive/${rel}" \
    "${HOME}/onedrive/${rel}" \
    "${HOME}/OneDrive - Personal/${rel}"; do
    if [[ -d "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  if [[ "${rel}" == OneDrive/* || "${rel}" == onedrive/* ]]; then
    echo "${HOME}/${rel}"
    return 0
  fi
  echo "${HOME}/OneDrive/${rel}"
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
    return 0
  fi
  expanded="$(expand_user_path "${trimmed}")"
  if command -v realpath >/dev/null 2>&1 && [[ -e "${expanded}" ]]; then
    realpath -m "${expanded}" 2>/dev/null || echo "${expanded}"
    return 0
  fi
  echo "${expanded}"
}


resolve_token_sync_dir() {
  local override="${1:-}"
  local resolved=""
  if [[ -n "$(echo "${override}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')" ]]; then
    normalize_token_sync_dir "${override}"
    return
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
