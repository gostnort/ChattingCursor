#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VENV_PY="${ROOT}/.venv/bin/python3"
if [[ ! -x "${VENV_PY}" ]]; then
  VENV_PY="${ROOT}/.venv/bin/python"
fi
if [[ ! -x "${VENV_PY}" ]]; then
  echo "未找到 .venv，请先运行项目根目录 ./install.sh" >&2
  exit 1
fi
echo "=== 安装 local_llm 推理依赖 ==="
"${VENV_PY}" -m pip install -U pip
"${VENV_PY}" -m pip install -r "${ROOT}/local_llm/server/requirements-inference.txt"
echo
echo "完成。请在 Web「本地 - 本地模型」页从 Hugging Face 安装 GGUF，或运行:"
echo "  python local_llm/server/check_hardware.py"
