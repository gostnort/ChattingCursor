#!/usr/bin/env python3
"""PilotTTS installation backend: hardware-aware PyTorch and dependency deployment."""

import os
import stat
import shutil
import subprocess
import sys
import time
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
GIT_TIMEOUT_SECONDS = 15
UPSTREAM_PRIMARY_URL = "https://github.com/AMAPVOICE/PilotTTS.git"
UPSTREAM_MIRROR_URL = "https://mirror.ghproxy.com/https://github.com/AMAPVOICE/PilotTTS.git"
HF_MIRROR_ENDPOINT = "https://hf-mirror.com"
HF_PILOT_REPO = "AmapVoice/PilotTTS"
HF_W2V_REPO = "facebook/w2v-bert-2.0"
HF_DOWNLOAD_MAX_RETRIES = 3
HF_RETRY_BACKOFF_SECONDS = (2, 5, 10)


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


def remove_readonly(func, path, excinfo) -> None:
    # 使用 pathlib.Path 修改只读属性后重试删除
    Path(path).chmod(stat.S_IWRITE)
    func(path)


def safe_remove_directory(target_dir: Path) -> None:
    # 安全删除指定目录，注册只读文件处理回调
    if target_dir.exists():
        log(f"[INFO] Safely removing directory: {target_dir}")
        shutil.rmtree(str(target_dir), onerror=remove_readonly)


def run_git(args: list[str], cwd: Path | None = None) -> None:
    # 执行 git 子命令并强制 15 秒超时，防止 Windows 网络握手挂起
    cmd = ["git"] + args
    cwd_str = str(cwd) if cwd is not None else None
    log(f"+ git {' '.join(args)}" + (f" (cwd={cwd})" if cwd else ""))
    subprocess.check_call(cmd, cwd=cwd_str, timeout=GIT_TIMEOUT_SECONDS)


def create_upstream_dir() -> Path:
    # 动态解析并确保 upstream 目录存在
    upstream_dir = ROOT / "upstream"
    upstream_dir.mkdir(parents=True, exist_ok=True)
    return upstream_dir


def resolve_origin_default_branch(target_dir: Path) -> str:
    # 解析远端默认分支名，兼容 main 与 master
    try:
        ref = subprocess.check_output(
            ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
            cwd=str(target_dir),
            text=True,
            timeout=GIT_TIMEOUT_SECONDS,
        ).strip()
        return ref.rsplit("/", 1)[-1]
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        for candidate in ("main", "master"):
            try:
                subprocess.check_call(
                    ["git", "rev-parse", f"origin/{candidate}"],
                    cwd=str(target_dir),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=GIT_TIMEOUT_SECONDS,
                )
                return candidate
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                continue
        raise RuntimeError("Unable to detect origin default branch after fetch")


def incremental_sync_upstream(target_dir: Path, repo_url: str) -> None:
    # 对已存在的 Git 仓库执行远程重定向、fetch 与 hard reset 增量同步
    run_git(["remote", "set-url", "origin", repo_url], cwd=target_dir)
    run_git(["fetch", "origin"], cwd=target_dir)
    default_branch = resolve_origin_default_branch(target_dir)
    run_git(["reset", "--hard", f"origin/{default_branch}"], cwd=target_dir)


def clone_upstream_fresh(target_dir: Path, repo_url: str) -> None:
    # 在 15 秒超时约束下执行浅克隆到 upstream 目录
    if target_dir.exists():
        safe_remove_directory(target_dir)
    run_git(["clone", "--depth", "1", repo_url, str(target_dir)])


def clone_or_update_upstream(target_dir: Path) -> None:
    # 对 upstream 目录执行增量同步或弹性克隆，失败时回退国内镜像
    git_dir = target_dir / ".git"
    if target_dir.exists() and git_dir.is_dir():
        log("[INFO] Existing upstream Git repository detected, performing incremental sync...")
        try:
            incremental_sync_upstream(target_dir, UPSTREAM_PRIMARY_URL)
            log("[OK] Upstream incremental sync via primary URL complete.")
            return
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as primary_err:
            log(f"[WARN] Primary incremental sync failed ({type(primary_err).__name__}), trying mirror...")
            try:
                incremental_sync_upstream(target_dir, UPSTREAM_MIRROR_URL)
                log("[OK] Upstream incremental sync via mirror complete.")
                return
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                log("[ERROR] Incremental sync failed on both primary and mirror URLs.")
                raise
    log("[INFO] Upstream missing or not a Git repository, starting fresh clone with 15s timeout...")
    if target_dir.exists() and not git_dir.is_dir():
        safe_remove_directory(target_dir)
    try:
        log("[INFO] Attempting direct clone from primary URL (15s timeout)...")
        clone_upstream_fresh(target_dir, UPSTREAM_PRIMARY_URL)
        log("[OK] Upstream cloned via primary URL.")
    except subprocess.TimeoutExpired:
        log("[WARN] Primary clone timed out after 15s, falling back to mirror...")
        clone_upstream_fresh(target_dir, UPSTREAM_MIRROR_URL)
        log("[OK] Upstream cloned via mirror after timeout.")
    except subprocess.CalledProcessError:
        log("[WARN] Primary clone failed, falling back to mirror...")
        clone_upstream_fresh(target_dir, UPSTREAM_MIRROR_URL)
        log("[OK] Upstream cloned via mirror.")


def verify_upstream_webui(target_dir: Path) -> None:
    # 校验 upstream 仓库克隆结果，确认 webui.py 存在
    webui_path = target_dir / "webui.py"
    if not webui_path.is_file():
        log(f"[ERROR] upstream/webui.py not found: {webui_path}")
        sys.exit(1)
    log(f"[OK] Verified upstream/webui.py at {webui_path}")


def configure_hf_mirror() -> None:
    # 注入 Hugging Face 国内镜像端点环境变量
    os.environ["HF_ENDPOINT"] = HF_MIRROR_ENDPOINT
    log(f"[INFO] HF_ENDPOINT set to {HF_MIRROR_ENDPOINT}")


def build_hf_download_script(weights_dir: Path) -> str:
    # 构建在虚拟环境中执行的 Hugging Face 权重并发下载脚本
    w2v_dir = weights_dir / "w2v-bert-2.0"
    return (
        "from pathlib import Path\n"
        "from huggingface_hub import snapshot_download\n"
        f'weights_path = Path(r"{weights_dir}")\n'
        f'print("Downloading {HF_PILOT_REPO}...")\n'
        f'snapshot_download("{HF_PILOT_REPO}", local_dir=str(weights_path), max_workers=4)\n'
        f'print("Downloading {HF_W2V_REPO}...")\n'
        f'snapshot_download("{HF_W2V_REPO}", local_dir=r"{w2v_dir}", max_workers=4)\n'
        'print("hf_download_done")\n'
    )


def run_hf_download(venv_py: Path, weights_dir: Path) -> None:
    # 在已配置镜像的环境中调用 snapshot_download 下载模型权重
    configure_hf_mirror()
    script = build_hf_download_script(weights_dir)
    subprocess.check_call(
        [str(venv_py), "-c", script],
        cwd=str(ROOT),
        env=os.environ.copy(),
    )


def verify_model_weights(weights_dir: Path) -> None:
    # 完整性检查：确认 pilot_tts.pt 与 w2v-bert-2.0 目录可用
    pilot_pt = weights_dir / "pilot_tts.pt"
    w2v_dir = weights_dir / "w2v-bert-2.0"
    if not pilot_pt.is_file() or pilot_pt.stat().st_size == 0:
        raise FileNotFoundError(f"Missing or empty model file: {pilot_pt}")
    if not w2v_dir.is_dir():
        raise FileNotFoundError(f"Missing model directory: {w2v_dir}")
    w2v_config = w2v_dir / "config.json"
    if not w2v_config.is_file() or w2v_config.stat().st_size == 0:
        raise FileNotFoundError(f"Missing or empty w2v-bert config: {w2v_config}")
    log(f"[OK] Model weights verified: {pilot_pt} and {w2v_dir}")


def download_hf_models(venv_py: Path, upstream_dir: Path) -> None:
    # 带退避重试的 Hugging Face 模型权重高速下载
    weights_dir = upstream_dir / "pretrained_models"
    weights_dir.mkdir(parents=True, exist_ok=True)
    log("=== Downloading Hugging Face model weights (mirror + retry) ===")
    for attempt in range(1, HF_DOWNLOAD_MAX_RETRIES + 1):
        try:
            log(f"[INFO] Model download attempt {attempt}/{HF_DOWNLOAD_MAX_RETRIES}...")
            run_hf_download(venv_py, weights_dir)
            verify_model_weights(weights_dir)
            log("[OK] Hugging Face model weights download complete.")
            return
        except (subprocess.CalledProcessError, FileNotFoundError, OSError) as err:
            if attempt >= HF_DOWNLOAD_MAX_RETRIES:
                log(f"[ERROR] Model download failed after {HF_DOWNLOAD_MAX_RETRIES} attempts: {err}")
                raise
            backoff = HF_RETRY_BACKOFF_SECONDS[attempt - 1]
            log(f"[WARN] Attempt {attempt} failed ({err}), retrying in {backoff}s...")
            time.sleep(backoff)


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
        log("=== PilotTTS Install Backend: Phase 4.1 Upstream Sync ===")
        upstream_dir = create_upstream_dir()
        clone_or_update_upstream(upstream_dir)
        verify_upstream_webui(upstream_dir)
        log("=== Phase 4.1 upstream sync complete ===")
        log("=== PilotTTS Install Backend: Phase 4.2 Model Weights ===")
        download_hf_models(VENV_PY, upstream_dir)
        log("=== Phase 4.2 model weights download complete ===")
        return 0
    except subprocess.CalledProcessError as exc:
        log(f"[ERROR] Command failed with exit code {exc.returncode}")
        return exc.returncode or 1
    except Exception as exc:
        log(f"[ERROR] {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
