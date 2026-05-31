#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VENV_PY="${ROOT}/.venv/bin/python3"
if [[ ! -x "${VENV_PY}" ]]; then
  VENV_PY="${ROOT}/.venv/bin/python"
fi
if [[ ! -x "${VENV_PY}" ]]; then
  echo ".venv not found. Run ./install.sh from the repo root first." >&2
  exit 1
fi
LLAMA_CPP_WHEEL_CPU="https://abetlen.github.io/llama-cpp-python/whl/cpu"
LLAMA_CPP_WHEEL_CU124="https://abetlen.github.io/llama-cpp-python/whl/cu124"
LLAMA_CPP_WHEEL_METAL="https://abetlen.github.io/llama-cpp-python/whl/metal"


install_llama_cpp_python() {
  local extra_index=""
  local -a pip_extra=()
  if command -v nvidia-smi >/dev/null 2>&1; then
    echo "检测到 NVIDIA GPU，安装 llama-cpp-python cu124 预编译 wheel..."
    extra_index="${LLAMA_CPP_WHEEL_CU124}"
    pip_extra=(--force-reinstall --no-cache-dir)
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    echo "检测到 macOS，安装 llama-cpp-python Metal 预编译 wheel..."
    extra_index="${LLAMA_CPP_WHEEL_METAL}"
  else
    echo "未检测到 NVIDIA GPU，安装 llama-cpp-python CPU 预编译 wheel..."
    extra_index="${LLAMA_CPP_WHEEL_CPU}"
  fi
  if ! "${VENV_PY}" -m pip install "llama-cpp-python>=0.3.0" "${pip_extra[@]}" --extra-index-url "${extra_index}"; then
    echo "错误：无法从 ${extra_index} 安装 llama-cpp-python 预编译 wheel。" >&2
    echo "请确认 Python 版本为 3.10–3.12（CUDA wheel 要求），然后手动重试：" >&2
    echo "  ${VENV_PY} -m pip install llama-cpp-python --extra-index-url ${extra_index}" >&2
    echo "若需从源码编译，请先安装 cmake、gcc/g++，再设置 CMAKE_ARGS 后 pip install。" >&2
    return 1
  fi
}


echo "=== Installing local_llm inference dependencies ==="
"${VENV_PY}" -m pip install -U pip
"${VENV_PY}" -m pip install -r "${ROOT}/local_llm/server/requirements-inference.txt"
install_llama_cpp_python
echo
echo "Done. Install GGUF weights in Web Local Models, or run:"
echo "  python local_llm/server/check_hardware.py"
