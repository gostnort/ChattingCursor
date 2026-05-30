#!/usr/bin/env bash
# 供 install-all.sh / run-all.sh 共用的路径与日志辅助

chattingcursor_repo_root() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "${script_dir}/../.." && pwd
}


chattingcursor_home_dir() {
  echo "${HOME}/.chattingcursor"
}


chattingcursor_temp_dir() {
  if [[ -n "${TMPDIR:-}" ]]; then
    echo "${TMPDIR}"
    return
  fi
  echo "/tmp"
}


log_step() {
  echo ""
  echo "==> $*"
}


log_ok() {
  echo "[OK] $*"
}


log_fail() {
  echo "[FAIL] $*"
}
