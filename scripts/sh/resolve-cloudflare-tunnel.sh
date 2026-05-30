#!/usr/bin/env bash
# 读取命名隧道配置；输出 tunnel 名与公开 URL（若已配置）

read_named_tunnel_public_url() {
  if [[ -n "${CHATTINGCURSOR_TUNNEL_NAME:-}" && -n "${CHATTINGCURSOR_TUNNEL_HOSTNAME:-}" ]]; then
    local host="${CHATTINGCURSOR_TUNNEL_HOSTNAME#https://}"
    host="${host#http://}"
    host="${host%/}"
    echo "${CHATTINGCURSOR_TUNNEL_NAME}"
    echo "https://${host}"
    return 0
  fi
  local config_path
  config_path="$(chattingcursor_home_dir)/cloudflare-tunnel.json"
  if [[ ! -f "${config_path}" ]] || ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi
  python3 -c 'import json,sys
path=sys.argv[1]
with open(path,encoding="utf-8") as f:
    cfg=json.load(f)
name=(cfg.get("tunnelName") or "").strip()
host=(cfg.get("publicHostname") or "").strip()
if not name or not host:
    raise SystemExit(1)
host=host.removeprefix("https://").removeprefix("http://").rstrip("/")
print(name)
print("https://"+host)' "${config_path}"
}
