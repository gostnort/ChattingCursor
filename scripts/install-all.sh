#!/usr/bin/env bash
# 一键安装：Python venv（可选 crewAI）、Node 依赖、shared 构建、cloudflared
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sh/common.sh
source "${SCRIPT_DIR}/sh/common.sh"

SKIP_CLOUDFLARED=0
for arg in "$@"; do
  if [[ "${arg}" == "--skip-cloudflared" ]]; then
    SKIP_CLOUDFLARED=1
  fi
done

ROOT="$(chattingcursor_repo_root)"
cd "${ROOT}"

NEEDS_RESTART=0

test_node_ready() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  [[ "${major}" -ge 20 ]]
}


ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return
  fi
  log_step "启用 corepack 并安装 pnpm..."
  corepack enable
  corepack prepare pnpm@9.15.9 --activate
}


ensure_python_venv() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "未检测到 python3；跳过可选 crewAI venv（核心聊天不依赖 Python）。"
    return
  fi
  local venv_py="${ROOT}/.venv/bin/python"
  if [[ ! -x "${venv_py}" ]]; then
    log_step "创建 Python venv 并安装 requirements.txt（可选 crewAI）..."
    python3 -m venv "${ROOT}/.venv"
    "${venv_py}" -m pip install --upgrade pip
    "${venv_py}" -m pip install -r "${ROOT}/requirements.txt"
  else
    echo "Python venv 已存在: ${ROOT}/.venv"
  fi
  if [[ -f "${ROOT}/local_llm/server/requirements-inference.txt" ]]; then
    log_step "安装 local_llm 本地推理依赖（llama-cpp-python、fastapi 等）..."
    "${venv_py}" -m pip install -r "${ROOT}/local_llm/server/requirements-inference.txt"
    echo "  local_llm 使用 GGUF + llama.cpp；在 Web「本地模型」页安装权重，或运行 local_llm/server/install.sh"
  fi
}


echo "=== ChattingCursor 安装 ==="
echo "项目目录: ${ROOT}"

if ! test_node_ready; then
  echo ""
  echo "未检测到 Node.js 20+。请先安装: https://nodejs.org/"
  echo "安装后重新运行 ./install.sh"
  exit 1
fi

ensure_python_venv

log_step "安装 pnpm 依赖..."
ensure_pnpm
pnpm install

log_step "构建 shared 包..."
pnpm --filter @chatting-cursor/shared build

if [[ "${SKIP_CLOUDFLARED}" -eq 0 ]]; then
  log_step "安装 cloudflared（隧道客户端）..."
  set +e
  bash "${SCRIPT_DIR}/install-cloudflared.sh"
  cf_exit=$?
  set -e
  if [[ "${cf_exit}" -eq 10 ]]; then
    NEEDS_RESTART=1
  elif [[ "${cf_exit}" -ne 0 ]]; then
    exit "${cf_exit}"
  fi
fi

echo ""
echo "安装完成。"
echo "local_llm 可选: ./local_llm/server/install.sh 安装推理依赖（在 Web「本地模型」页安装 GGUF）"
echo "下一步: ./run.sh"
echo "手机远程: 默认 token 在 ~/.chattingcursor/chattingcursor-token.txt；可放进云盘或于配置页改路径。"
echo ""

if [[ "${NEEDS_RESTART}" -eq 1 ]]; then
  exit 10
fi
exit 0
