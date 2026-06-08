#!/usr/bin/env python3
"""PilotTTS installation backend: hardware-aware PyTorch and dependency deployment."""

import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
VENV_PY = ROOT / ".venv" / "Scripts" / "python.exe"
REQUIREMENTS = ROOT / "requirements-inference.txt"
DEFAULT_TORCH_EXTRA_URL = "https://download.pytorch.org/whl/cpu"
PYWORLD_PRIMARY_WHL = (
    "https://github.com/cgohlke/winpython-wheels/releases/download/v2023.2.0/"
    "pyworld-0.3.4-cp310-cp310-win_amd64.whl"
)
PYWORLD_BACKUP_WHL = (
    "https://mirrors.aliyun.com/pypi/packages/cp310/p/pyworld/"
    "pyworld-0.3.4-cp310-cp310-win_amd64.whl"
)
SKIP_REQUIREMENT_PREFIXES = ("torch==", "torchaudio==", "pyworld")


def log(message: str) -> None:
    print(message, flush=True)


def resolve_torch_extra_url() -> str:
    # 从环境变量读取 Phase 2 传递的 PyTorch 额外索引 URL，缺省回退 CPU 源
    extra_url = os.environ.get("PILOT_TTS_TORCH_EXTRA_URL", "").strip()
    if extra_url:
        return extra_url
    log("[WARN] PILOT_TTS_TORCH_EXTRA_URL not set, defaulting to CPU PyTorch index.")
    return DEFAULT_TORCH_EXTRA_URL


def run_uv_pip(args: list[str]) -> None:
    # 使用 uv pip 在隔离虚拟环境中执行包安装命令
    cmd = ["uv", "pip", "install", "--python", str(VENV_PY)] + args
    log(f"+ {' '.join(cmd)}")
    subprocess.check_call(cmd, cwd=str(ROOT))


def ensure_venv_python() -> Path:
    # 校验 Phase 2 创建的 Python 3.10 虚拟环境解释器是否存在
    if not VENV_PY.is_file():
        log(f"[ERROR] Virtual environment not found: {VENV_PY}")
        log("[ERROR] Run install.ps1 Phase 2 before install_backend.py.")
        sys.exit(1)
    out = subprocess.check_output([str(VENV_PY), "--version"], text=True).strip()
    if "3.10." not in out:
        log(f"[ERROR] Expected Python 3.10.x, found: {out}")
        sys.exit(1)
    log(f"[OK] {out}")
    return VENV_PY


def install_pytorch(extra_url: str) -> None:
    # 根据硬件检测结果安装匹配版本的 torch 与 torchaudio
    log("=== Installing hardware-matched PyTorch packages ===")
    run_uv_pip([
        "torch==2.5.1",
        "torchaudio==2.5.1",
        "--extra-index-url",
        extra_url,
    ])
    log("[OK] PyTorch installation complete.")


def verify_pyworld_import() -> bool:
    # 校验 pyworld 是否可正常导入，用于检测 ABI 不兼容的伪成功安装
    try:
        subprocess.check_call(
            [str(VENV_PY), "-c", "import pyworld"],
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except subprocess.CalledProcessError:
        return False


def install_pyworld_from_wheel() -> None:
    # 通过预编译 Wheel 强行安装 pyworld，依次尝试主备下载源
    try:
        log("[INFO] Installing pyworld from primary precompiled wheel...")
        run_uv_pip([PYWORLD_PRIMARY_WHL])
        if verify_pyworld_import():
            log("[OK] pyworld installed via primary wheel.")
            return
        log("[WARN] Primary wheel import check failed, trying backup wheel...")
    except subprocess.CalledProcessError:
        log("[WARN] Primary wheel install failed, falling back to Aliyun mirror wheel...")
    run_uv_pip([PYWORLD_BACKUP_WHL])
    if not verify_pyworld_import():
        log("[ERROR] pyworld wheel installation succeeded but import verification failed.")
        sys.exit(1)
    log("[OK] pyworld installed via backup wheel.")


def install_pyworld_whl() -> None:
    # 先固定 numpy 1.x 再尝试常规安装，失败或 ABI 不兼容时回退预编译 Wheel
    log("=== Installing pyworld (compilation-free wheel strategy) ===")
    run_uv_pip(["numpy>=1.23,<2"])
    try:
        log("[INFO] Attempting standard pyworld install...")
        run_uv_pip(["pyworld==0.3.4"])
        if verify_pyworld_import():
            log("[OK] pyworld installed via standard channel.")
            return
        log("[WARN] Standard pyworld install passed but import check failed, using precompiled wheel...")
    except subprocess.CalledProcessError:
        log("[WARN] Standard pyworld install failed, falling back to precompiled wheel...")
    install_pyworld_from_wheel()


def build_filtered_requirements() -> Path:
    # 过滤 requirements 中已由前序步骤安装的 torch、torchaudio、pyworld 及索引行
    if not REQUIREMENTS.is_file():
        log(f"[ERROR] Requirements file not found: {REQUIREMENTS}")
        sys.exit(1)
    lines: list[str] = []
    for raw_line in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            lines.append(raw_line)
            continue
        if stripped.startswith("--"):
            continue
        lower = stripped.lower()
        if any(lower.startswith(prefix) for prefix in SKIP_REQUIREMENT_PREFIXES):
            continue
        if lower == "numpy" or lower.startswith("numpy"):
            lines.append("numpy>=1.23,<2")
            continue
        lines.append(raw_line)
    filtered = "\n".join(lines) + "\n"
    temp_dir = ROOT / ".install-logs"
    temp_dir.mkdir(parents=True, exist_ok=True)
    filtered_path = temp_dir / "requirements-inference-filtered.txt"
    filtered_path.write_text(filtered, encoding="utf-8")
    return filtered_path


def install_requirements() -> None:
    # 批量安装 requirements-inference.txt 中除 PyTorch 与 pyworld 外的常规依赖
    log("=== Installing remaining inference dependencies ===")
    filtered_path = build_filtered_requirements()
    run_uv_pip(["-r", str(filtered_path)])
    log("[OK] Inference dependencies installation complete.")


def verify_imports() -> None:
    # 验证关键科学计算与推理依赖是否可成功导入
    log("=== Verifying key dependency imports ===")
    verify_script = (
        "import torch; import torchaudio; import pyworld; import transformers; "
        "import numpy; import librosa; "
        "print('torch=' + torch.__version__ + ' cuda=' + str(torch.cuda.is_available()))"
    )
    subprocess.check_call([str(VENV_PY), "-c", verify_script], cwd=str(ROOT))
    log("[OK] Key dependency import verification passed.")


def main() -> int:
    try:
        log("=== PilotTTS Install Backend: Phase 3 Dependency Deployment ===")
        ensure_venv_python()
        extra_url = resolve_torch_extra_url()
        log(f"[INFO] PyTorch extra-index-url: {extra_url}")
        install_pytorch(extra_url)
        install_pyworld_whl()
        install_requirements()
        verify_imports()
        log("=== Phase 3 dependency deployment complete ===")
        return 0
    except subprocess.CalledProcessError as exc:
        log(f"[ERROR] Command failed with exit code {exc.returncode}")
        return exc.returncode or 1
    except Exception as exc:
        log(f"[ERROR] {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
