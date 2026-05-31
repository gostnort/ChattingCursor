"""检查 local_llm GGUF 本地推理的硬件与磁盘是否大致满足要求。"""

import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path


DEFAULT_GGUF_GB = 5.5
MIN_RAM_GB = 8


def read_env(name: str, legacy: str = "") -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    return os.environ.get(legacy, "").strip() if legacy else ""


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


def local_llm_root() -> Path:
    override = read_env("CHATTINGCURSOR_LOCAL_LLM_DIR", "CHATTINGCURSOR_GEMMA4_DIR")
    if override:
        return Path(override).expanduser()
    return repo_root() / "local_llm"


def find_any_gguf(root: Path) -> Path | None:
    if not root.is_dir():
        return None
    for path in sorted(root.rglob("*.gguf")):
        if path.is_file():
            return path
    return None


def format_gb(value: float) -> str:
    return f"{value:.1f} GB"


def check_ram() -> tuple[bool, str]:
    try:
        import psutil
    except ImportError:
        return True, "未安装 psutil，跳过内存检测（pip install psutil 可启用）"
    total = psutil.virtual_memory().total / (1024 ** 3)
    ok = total >= MIN_RAM_GB
    msg = f"系统内存 {format_gb(total)}（建议 ≥ {MIN_RAM_GB} GB）"
    return ok, msg


def check_disk(directory: Path, need_gb: float) -> tuple[bool, str]:
    directory.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(directory)
    free_gb = usage.free / (1024 ** 3)
    ok = free_gb >= need_gb
    msg = f"磁盘可用 {format_gb(free_gb)} @ {directory}（GGUF 约需 {need_gb:.1f} GB）"
    return ok, msg


def probe_nvidia_smi() -> tuple[str | None, float | None]:
    if shutil.which("nvidia-smi") is None:
        return None, None
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return None, None
        line = result.stdout.strip().splitlines()[0]
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 2:
            return None, None
        name = parts[0]
        vram_gb = float(parts[1]) / 1024
        return name, vram_gb
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None, None


def check_gpu() -> tuple[bool, str]:
    llama_msg = "未安装 llama-cpp-python（运行 local_llm/server/install.sh 或 install.bat）"
    try:
        import llama_cpp  # noqa: F401
        llama_msg = "llama-cpp-python 已安装"
    except (ImportError, RuntimeError) as exc:
        llama_msg = f"llama-cpp-python 不可用：{exc}"
    gpu_name, vram_gb = probe_nvidia_smi()
    if gpu_name and vram_gb is not None:
        gpu_msg = f"GPU: {gpu_name}（{format_gb(vram_gb)}）"
        if llama_msg == "llama-cpp-python 已安装":
            if vram_gb <= 14:
                gpu_msg += "；26B 等大模型建议 LOCAL_LLM_N_GPU_LAYERS=35（混合模式：GPU 层 + CPU 内存）"
            else:
                gpu_msg += "；可设 LOCAL_LLM_N_GPU_LAYERS=-1 尽量全 GPU"
    else:
        gpu_msg = "未检测到 NVIDIA GPU（nvidia-smi 不可用或无独显）"
    return True, f"{llama_msg}；{gpu_msg}"


def main() -> int:
    parser = argparse.ArgumentParser(description="local_llm GGUF 硬件自检")
    parser.add_argument("--need-gb", type=float, default=DEFAULT_GGUF_GB, help="预期 GGUF 体积 (GB)")
    args = parser.parse_args()
    root = local_llm_root()
    gguf_path = find_any_gguf(root)
    print(f"平台: {platform.system()} {platform.release()}")
    print(f"local_llm 根目录: {root}")
    if gguf_path is not None:
        size_gb = gguf_path.stat().st_size / (1024 ** 3)
        print(f"已找到 GGUF: {gguf_path.relative_to(root)} ({format_gb(size_gb)})")
        need_gb = max(args.need_gb, size_gb * 1.1)
    else:
        print("未找到已安装 *.gguf（请在 Web「本地模型」页安装）")
        need_gb = args.need_gb
    checks: list[tuple[str, bool, str]] = []
    ok_ram, msg_ram = check_ram()
    checks.append(("内存", ok_ram, msg_ram))
    ok_disk, msg_disk = check_disk(root, need_gb)
    checks.append(("磁盘", ok_disk, msg_disk))
    ok_gpu, msg_gpu = check_gpu()
    checks.append(("GPU", ok_gpu, msg_gpu))
    failed = False
    for label, ok, msg in checks:
        status = "OK" if ok else "WARN"
        if not ok:
            failed = True
        print(f"[{status}] {label}: {msg}")
    if gguf_path is None:
        return 2 if failed else 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
