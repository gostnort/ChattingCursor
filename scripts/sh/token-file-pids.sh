#!/usr/bin/env bash
# token 文件中的 pid.* 段（由 run-all 写入，shutdown 读取）

TOKEN_PID_HEADER="# processes (managed by run-all)"
MANAGED_PID_KEYS=(bridge web cloudflared quality-watch run-all)


is_token_pid_line() {
  local line="$1"
  local trimmed
  trimmed="$(echo "${line}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [[ -z "${trimmed}" ]] && return 1
  [[ "${trimmed}" == "${TOKEN_PID_HEADER}" ]] && return 0
  [[ "${trimmed}" =~ ^pid\.[a-z0-9-]+[[:space:]]*= ]]
}


get_token_file_pid_map() {
  local file_path="$1"
  local key pid
  if [[ ! -f "${file_path}" ]]; then
    return 0
  fi
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ "${line}" =~ ^[[:space:]]*pid\.([a-z0-9-]+)[[:space:]]*=[[:space:]]*([0-9]+)[[:space:]]*$ ]]; then
      key="${BASH_REMATCH[1]}"
      pid="${BASH_REMATCH[2]}"
      printf '%s %s\n' "${key}" "${pid}"
    fi
  done < "${file_path}"
}


remove_token_pid_lines_from_content() {
  local file_path="$1"
  local out_path="$2"
  if [[ ! -f "${file_path}" ]]; then
    : >"${out_path}"
    return
  fi
  : >"${out_path}"
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if is_token_pid_line "${line}"; then
      continue
    fi
    printf '%s\n' "${line}" >>"${out_path}"
  done < "${file_path}"
  while [[ -s "${out_path}" ]]; do
    if [[ -z "$(tail -n 1 "${out_path}" | tr -d '[:space:]')" ]]; then
      head -n -1 "${out_path}" >"${out_path}.trim" 2>/dev/null && mv "${out_path}.trim" "${out_path}" || break
    else
      break
    fi
  done
}


write_token_file_content_with_retry() {
  local file_path="$1"
  local content_file="$2"
  local attempt
  for attempt in $(seq 1 8); do
    if cp "${content_file}" "${file_path}" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  echo "[WARN] 写入 token 文件失败（可能被占用）: ${file_path}" >&2
  return 1
}


format_token_pid_section() {
  local -n pid_map_ref="$1"
  local key pid
  local has_any=0
  for key in "${MANAGED_PID_KEYS[@]}"; do
    pid="${pid_map_ref[${key}]:-}"
    if [[ -n "${pid}" && "${pid}" -gt 0 ]]; then
      if [[ "${has_any}" -eq 0 ]]; then
        echo "${TOKEN_PID_HEADER}"
        has_any=1
      fi
      echo "pid.${key}=${pid}"
    fi
  done
}


merge_token_file_pid_section() {
  local file_path="$1"
  local -n pid_map_ref="$2"
  local cloudflared_only="${3:-0}"
  local tmp_auth tmp_out key pid line
  declare -A merged=()
  if [[ "${cloudflared_only}" -eq 1 && -f "${file_path}" ]]; then
    while read -r key pid; do
      merged["${key}"]="${pid}"
    done < <(get_token_file_pid_map "${file_path}")
  fi
  for key in "${!pid_map_ref[@]}"; do
    pid="${pid_map_ref[${key}]}"
    if [[ "${cloudflared_only}" -eq 1 && "${key}" != "cloudflared" ]]; then
      continue
    fi
    if [[ -n "${pid}" && "${pid}" -gt 0 ]]; then
      merged["${key}"]="${pid}"
    fi
  done
  tmp_auth="$(mktemp)"
  tmp_out="$(mktemp)"
  if [[ -f "${file_path}" ]]; then
    remove_token_pid_lines_from_content "${file_path}" "${tmp_auth}"
  else
    : >"${tmp_auth}"
  fi
  if [[ ! -s "${tmp_auth}" && ! -f "${file_path}" ]]; then
    rm -f "${tmp_auth}" "${tmp_out}"
    return 0
  fi
  cat "${tmp_auth}" >"${tmp_out}"
  if [[ ${#merged[@]} -gt 0 ]]; then
    if [[ -s "${tmp_out}" ]]; then
      echo "" >>"${tmp_out}"
    fi
    format_token_pid_section merged >>"${tmp_out}"
  fi
  if [[ ! -s "${tmp_out}" ]]; then
    rm -f "${file_path}" "${tmp_auth}" "${tmp_out}" 2>/dev/null || true
    return 0
  fi
  local parent_dir
  parent_dir="$(dirname "${file_path}")"
  if [[ ! -d "${parent_dir}" ]]; then
    echo "[WARN] token 文件父目录不存在，跳过 pid 写入: ${parent_dir}" >&2
    rm -f "${tmp_auth}" "${tmp_out}"
    return 1
  fi
  write_token_file_content_with_retry "${file_path}" "${tmp_out}"
  rm -f "${tmp_auth}" "${tmp_out}"
}


clear_token_file_pid_section() {
  local file_path="$1"
  local tmp_auth
  if [[ ! -f "${file_path}" ]]; then
    return 0
  fi
  tmp_auth="$(mktemp)"
  remove_token_pid_lines_from_content "${file_path}" "${tmp_auth}"
  if [[ ! -s "${tmp_auth}" ]]; then
    rm -f "${file_path}" "${tmp_auth}"
    return 0
  fi
  write_token_file_content_with_retry "${file_path}" "${tmp_auth}"
  rm -f "${tmp_auth}"
}
