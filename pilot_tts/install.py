#!/usr/bin/env python3
"""从 GitHub 安装 PilotTTS 上游，并从 Hugging Face 下载默认权重。"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
UPSTREAM = ROOT / "upstream"
VENV_DIR = ROOT / ".venv"
VENV_PY = VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
INFERENCE_REQUIREMENTS = ROOT / "requirements-inference.txt"
REPO_URL = "https://github.com/AMAPVOICE/PilotTTS.git"
HF_PILOT_REPO = "AmapVoice/PilotTTS"
HF_W2V_REPO = "facebook/w2v-bert-2.0"
WEIGHTS_HINT_GB = "约 3–5"
WINDOWS_INSTALL_HINT = (
    "若日志出现 pynini / WeTextProcessing 编译错误，多为曾误装上游完整 requirements。"
    "请删除 pilot_tts\\.venv 后重试；本安装使用 requirements-inference.txt（不含 WeTextProcessing）。"
    "Windows 将优先使用 Python 3.10/3.11。若无可用版本请安装 Python 3.10："
    "https://www.python.org/downloads/release/python-31011/"
)


def log(message: str) -> None:
    print(message, flush=True)


def run_checked(args: list[str], cwd: Path | None = None) -> None:
    log(f"+ {' '.join(args)}")
    subprocess.check_call(args, cwd=str(cwd or ROOT))


def python_version_tuple(exe: Path) -> tuple[int, int]:
    out = subprocess.check_output(
        [str(exe), "-c", "import sys; print(sys.version_info.major, sys.version_info.minor)"],
        text=True,
    ).strip()
    major, minor = out.split()
    return int(major), int(minor)


def resolve_creator_python() -> Path:
    if sys.platform == "win32":
        for flag in ("-3.10", "-3.11"):
            try:
                out = subprocess.check_output(
                    ["py", flag, "-c", "import sys; print(sys.executable)"],
                    text=True,
                    stderr=subprocess.DEVNULL,
                ).strip()
                if out:
                    exe = Path(out)
                    ver = python_version_tuple(exe)
                    log(f"[ok] Windows 将使用 Python {ver[0]}.{ver[1]}：{exe}")
                    return exe
            except (subprocess.CalledProcessError, FileNotFoundError):
                continue
        ver = python_version_tuple(Path(sys.executable))
        if ver >= (3, 12):
            log(
                "[warn] 未找到 py -3.10 / py -3.11，当前为 "
                f"Python {ver[0]}.{ver[1]}；若 pip 安装失败请安装 Python 3.10 后重试。"
            )
    return Path(sys.executable)


def should_recreate_venv(creator: Path) -> bool:
    if not VENV_PY.is_file():
        return False
    current = python_version_tuple(VENV_PY)
    target = python_version_tuple(creator)
    if current == target:
        return False
    log(
        f"[warn] 已有 .venv 为 Python {current[0]}.{current[1]}，"
        f"将用 Python {target[0]}.{target[1]} 重建"
    )
    return True


def remove_venv() -> None:
    if VENV_DIR.exists():
        log(f"[warn] 删除旧虚拟环境：{VENV_DIR}")
        shutil.rmtree(VENV_DIR, ignore_errors=True)


def ensure_venv() -> Path:
    creator = resolve_creator_python()
    if should_recreate_venv(creator):
        remove_venv()
    if not VENV_PY.is_file():
        log(f"=== 创建虚拟环境（{creator}）===")
        run_checked([str(creator), "-m", "venv", str(VENV_DIR)])
    ver = python_version_tuple(VENV_PY)
    log(f"[ok] 虚拟环境 Python {ver[0]}.{ver[1]}：{VENV_PY}")
    run_checked([str(VENV_PY), "-m", "pip", "install", "--upgrade", "pip"])
    return VENV_PY


def ensure_upstream_clone() -> Path:
    if UPSTREAM.is_dir() and (UPSTREAM / "webui.py").is_file():
        log(f"[ok] 上游已存在：{UPSTREAM}")
        return UPSTREAM
    if UPSTREAM.exists():
        log(f"[warn] 删除不完整的 upstream：{UPSTREAM}")
        shutil.rmtree(UPSTREAM, ignore_errors=True)
    run_checked(["git", "clone", "--depth", "1", REPO_URL, str(UPSTREAM)])
    if not (UPSTREAM / "webui.py").is_file():
        raise RuntimeError("克隆完成但未找到 webui.py，请检查网络或 GitHub 可用性。")
    log(f"[ok] 已克隆 {REPO_URL}")
    return UPSTREAM


def pip_install_upstream(python: Path, upstream: Path) -> None:
    requirements = INFERENCE_REQUIREMENTS
    if not requirements.is_file():
        raise RuntimeError(f"未找到 {requirements}")
    log(
        "=== 安装推理依赖（requirements-inference.txt，不含 WeTextProcessing）==="
    )
    run_checked([str(python), "-m", "pip", "install", "-r", str(requirements)])
    run_checked([str(python), "-m", "pip", "install", "huggingface_hub", "fastapi", "uvicorn"])


def weights_already_present() -> bool:
    weights_dir = UPSTREAM / "pretrained_models"
    return (weights_dir / "pilot_tts.pt").is_file() or (weights_dir / "pilot_tts_instruct.pt").is_file()


def prompt_download_weights(skip_weights: bool) -> bool:
    if skip_weights:
        log("[skip] 已指定 --skip-weights，跳过 Hugging Face 权重下载。")
        return False
    if os.environ.get("PILOT_TTS_SKIP_WEIGHTS", "").strip().lower() in ("1", "true", "yes"):
        log("[skip] 环境变量 PILOT_TTS_SKIP_WEIGHTS=1，跳过权重下载。")
        return False
    if os.environ.get("PILOT_TTS_INSTALL_NONINTERACTIVE", "").strip().lower() in ("1", "true", "yes"):
        log(f"=== 非交互安装：即将下载 Hugging Face 权重（{WEIGHTS_HINT_GB} GB）===")
        return True
    if weights_already_present():
        log("[ok] 检测到已有权重文件，跳过下载。")
        return False
    if not sys.stdin.isatty():
        log(f"=== 非 TTY 环境：即将下载 Hugging Face 权重（{WEIGHTS_HINT_GB} GB）===")
        return True
    log("")
    log(f"即将从 Hugging Face 下载语音模型权重（{WEIGHTS_HINT_GB} GB，AmapVoice/PilotTTS + w2v-bert-2.0）。")
    log("下载完成后方可在「语音」页勾选「启用朗读 API」。")
    answer = input("是否现在下载？[Y/n]: ").strip().lower()
    if answer in ("n", "no", "0"):
        log("[skip] 已跳过权重下载；稍后可重新运行 install.bat 或 install.py 下载。")
        return False
    return True


def download_weights(python: Path, upstream: Path) -> Path:
    weights_dir = upstream / "pretrained_models"
    weights_dir.mkdir(parents=True, exist_ok=True)
    log(f"=== 下载默认大模型（{WEIGHTS_HINT_GB} GB，可能较久）===")
    script = f"""
from huggingface_hub import snapshot_download
snapshot_download("{HF_PILOT_REPO}", local_dir=r"{weights_dir}")
snapshot_download("{HF_W2V_REPO}", local_dir=r"{weights_dir / "w2v-bert-2.0"}")
print("weights_done")
"""
    run_checked([str(python), "-c", script])
    pilot_pt = weights_dir / "pilot_tts.pt"
    if not pilot_pt.is_file():
        raise RuntimeError(f"权重下载后未找到 {pilot_pt}")
    log(f"[ok] 权重已就绪：{weights_dir}")
    return weights_dir


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="安装 PilotTTS 上游与可选 Hugging Face 权重")
    parser.add_argument(
        "--skip-weights",
        action="store_true",
        help="跳过 Hugging Face 权重下载（仅安装代码与依赖）",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        log("=== PilotTTS 安装：GitHub 上游 + Hugging Face 权重 ===")
        python = ensure_venv()
        upstream = ensure_upstream_clone()
        log("=== 安装 Python 依赖（可能较久）===")
        pip_install_upstream(python, upstream)
        if prompt_download_weights(args.skip_weights):
            download_weights(python, upstream)
        elif not weights_already_present():
            log("[warn] 权重未下载；请稍后运行 install.bat 或在「语音」页点击「安装 PilotTTS」。")
        log("=== 完成 ===")
        log("Bridge 朗读 API：http://127.0.0.1:4323")
        log("Pilot 配置 WebUI：http://127.0.0.1:4324 （需在语音页勾选「启用朗读 API」后可选 WebUI）")
        return 0
    except subprocess.CalledProcessError as exc:
        log(f"[error] 命令失败 exit={exc.returncode}")
        if sys.platform == "win32":
            log(f"[hint] {WINDOWS_INSTALL_HINT}")
        return exc.returncode or 1
    except Exception as exc:
        log(f"[error] {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
