#!/usr/bin/env bash
# 解析 token 同步目录：参数/环境变量 > ~/.chattingcursor/config.json > 默认 ~/.chattingcursor

resolve_token_sync_dir() {
  local override="${1:-}"
  if [[ -n "${override// }" ]]; then
    echo "${override// /}"
    return
  fi
  if [[ -n "${CHATTINGCURSOR_TOKEN_SYNC_DIR:-}" ]]; then
    echo "${CHATTINGCURSOR_TOKEN_SYNC_DIR}"
    return
  fi
  local config_path
  config_path="$(chattingcursor_home_dir)/config.json"
  if [[ -f "${config_path}" ]] && command -v python3 >/dev/null 2>&1; then
    local from_file
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
      echo "${from_file}"
      return
    fi
  fi
  chattingcursor_home_dir
}
