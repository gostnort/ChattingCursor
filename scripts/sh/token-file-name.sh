#!/usr/bin/env bash
# 与 bridge paths.ts 一致的 token 文件名（短主机名 + 非法字符替换）

sanitize_hostname_for_filename() {
  local raw="${1:-}"
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  if [[ -z "${raw}" ]]; then
    echo "unknown"
    return
  fi
  local sanitized
  sanitized="$(printf '%s' "${raw}" | sed -E 's/[<>:"/\\|?*[:cntrl:]]/_/g;s/[[:space:]]+/_/g;s/^\.+//;s/\.+$//')"
  if [[ -z "${sanitized}" ]]; then
    echo "unknown"
    return
  fi
  echo "${sanitized:0:63}"
}


chattingcursor_short_hostname() {
  local raw
  raw="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "")"
  raw="${raw%%.*}"
  sanitize_hostname_for_filename "${raw}"
}


chattingcursor_token_file_name() {
  if [[ -n "${CHATTINGCURSOR_TOKEN_FILE_NAME:-}" ]]; then
    echo "${CHATTINGCURSOR_TOKEN_FILE_NAME}"
    return
  fi
  local host
  host="$(chattingcursor_short_hostname)"
  echo "chattingcursor-${host}-token.txt"
}


chattingcursor_token_file_path() {
  local sync_dir="${1:-}"
  echo "${sync_dir}/$(chattingcursor_token_file_name)"
}
