# PilotTTS Installation and Configuration Technical Implementation Plan (plan.md)

## 1. Technical Architecture Design

The new installation and configuration process adopts a layered hybrid script architecture to balance ease of use, cross-platform compatibility, and high performance:

```
+-------------------------------------------------------+
|                 1. Shortcut Entry: install.bat        |
|  (Bypasses PowerShell execution policies, launches    |
|   install.ps1)                                        |
+--------------------------+----------------------------+
                           |
                           v
+-------------------------------------------------------+
|                2. Core Controller: install.ps1        |
|  (Performs preflights, GPU detection, silent uv       |
|   installation, and creates isolated .venv)           |
+--------------------------+----------------------------+
                           |
                           v
+-------------------------------------------------------+
|               3. Business Executor: install_backend.py|
|  (Handles resilient Git clone, lightning-fast pip     |
|   installations, and high-availability HF downloads)  |
+-------------------------------------------------------+
```

### 1.1 Architectural Division of Labor
1.  **`install.bat` (Shortcut Entry)**: Serves as a quick entry point for Windows users. Its primary job is to bypass the default PowerShell script execution policy and safely pass control to `install.ps1`.
2.  **`install.ps1` (Core Environment Controller)**:
    *   Pre-checks if `git` is available in the system `PATH`.
    *   Detects if the high-performance package manager `uv` is installed locally. If not, silently and rapidly installs `uv` via official channels and adds it to the current session's `PATH`.
    *   Queries Windows WMI/CIM services to detect if the user has an NVIDIA discrete graphics card, determining the appropriate PyTorch hardware acceleration package version.
    *   Invokes `uv venv --python 3.10 .venv` to silently download the Python 3.10 distribution and automatically create an isolated virtual environment.
3.  **`install_backend.py` (Business Installer & Downloader)**:
    *   Written in Python (fully utilizing the `pathlib` library and Chinese comments, adhering to strict formatting specifications).
    *   Utilizes multi-threading, backoff retries, and domestic GitHub/HF mirrors to resiliently download the `upstream` code and large model weights.

---

## 2. Core Technical Implementation Details

### 2.1 Automated Python 3.10 Configuration via `uv`
`uv` has extremely powerful automatic Python version retrieval and downloading capabilities. When running:

```powershell
# 在 PowerShell 中通过 uv 创建隔离的 Python 3.10 虚拟环境
uv venv --python 3.10 .venv
```

`uv` automatically locates and pulls a pre-compiled high-performance Python 3.10 green package, extracts it, and sets it up under `.venv`. This offers several key advantages:
1.  **Complete Independence**: Does not modify the user's global Windows environment variables (does not write to system PATH, does not pollute other Python environments).
2.  **Zero Wizard Prompts**: Users will not see any pop-up installation windows or User Account Control (UAC) authorization prompts.
3.  **Perfect Version Compatibility**: Python 3.10.x has excellent Wheel compatibility, allowing direct installation of `pyworld` without compilation, eliminating MSVC `cl.exe` compilation errors.

### 2.2 Network Resilience Mechanisms

#### 2.2.1 GitHub Clone & Fetch 15-Second Hard Timeout and Incremental Redirection
When managing the `upstream` directory, a strict 15-second timeout is enforced via `subprocess` parameter `timeout=15`. If the directory already exists, it is incrementally updated rather than violently deleted. If cloning or updating fails/times out, the `subprocess.TimeoutExpired` exception is caught, triggering an automatic fallback to the domestic high-speed proxy.

# 这是一个超过 10 行 of Python 代码块，展示了 15 秒超时机制及 upstream 增量更新与重定向的具体实现逻辑
```python
import stat
import shutil
import subprocess
import sys
from pathlib import Path


def remove_readonly(func, path, excinfo):
    # 使用 pathlib.Path 代替 os.chmod 修改只读属性
    Path(path).chmod(stat.S_IWRITE)
    func(path)


def create_upstream_dir() -> Path:
    # 动态解析并返回 upstream 绝对路径
    root_dir = Path(__file__).resolve().parent
    upstream_dir = root_dir / "upstream"
    upstream_dir.mkdir(parents=True, exist_ok=True)
    return upstream_dir


def clone_or_update_upstream(target_dir: Path) -> None:
    # 定义官方和国内加速镜像代理源
    primary_url = "https://github.com/AMAPVOICE/PilotTTS.git"
    mirror_url = "https://mirror.ghproxy.com/https://github.com/AMAPVOICE/PilotTTS.git"
    git_dir = target_dir / ".git"
    # 下面是一个超过10行的代码块，实现对 upstream 目录的增量检测、重定向与 15 秒超时硬截断克隆
    if target_dir.exists() and git_dir.exists():
        print("检测到 upstream 目录已存在且为 Git 仓库，正在进行增量重定向更新...")
        try:
            print("重定向远程仓库地址并同步...")
            subprocess.check_call(["git", "remote", "set-url", "origin", primary_url], cwd=str(target_dir), timeout=15)
            subprocess.check_call(["git", "fetch", "origin"], cwd=str(target_dir), timeout=15)
            subprocess.check_call(["git", "reset", "--hard", "origin/main"], cwd=str(target_dir), timeout=15)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as err:
            print(f"标准同步失败或超时 ({type(err).__name__})，尝试通过国内镜像重定向并更新...")
            try:
                subprocess.check_call(["git", "remote", "set-url", "origin", mirror_url], cwd=str(target_dir), timeout=15)
                subprocess.check_call(["git", "fetch", "origin"], cwd=str(target_dir), timeout=15)
                subprocess.check_call(["git", "reset", "--hard", "origin/main"], cwd=str(target_dir), timeout=15)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                print("增量同步失败，将在后续进行全新重建。")
                raise
    else:
        print("upstream 目录不存在，启动全新的 15 秒超时弹性克隆流程...")
        try:
            print("正在尝试 15 秒内直接克隆官方 PilotTTS 仓库...")
            subprocess.check_call(["git", "clone", "--depth", "1", primary_url, str(target_dir)], timeout=15)
        except subprocess.TimeoutExpired:
            print("直连克隆在 15 秒内超时未响应，立即执行硬截断并回退至国内高速镜像代理...")
            if target_dir.exists():
                shutil.rmtree(str(target_dir), onerror=remove_readonly)
            subprocess.check_call(["git", "clone", "--depth", "1", mirror_url, str(target_dir)], timeout=15)
        except subprocess.CalledProcessError:
            print("直连克隆发生错误，正在自动重试并回退至国内镜像代理...")
            if target_dir.exists():
                shutil.rmtree(str(target_dir), onerror=remove_readonly)
            subprocess.check_call(["git", "clone", "--depth", "1", mirror_url, str(target_dir)], timeout=15)


if __name__ == "__main__":
    target = create_upstream_dir()
    clone_or_update_upstream(target)
```

#### 2.2.2 Hugging Face Mirror Coverage
To handle slow Hugging Face connections:
1.  During PowerShell or Python process initialization, inject the environment variable:
    `$env:HF_ENDPOINT = "https://hf-mirror.com"`
2.  Initiate the snapshot download via `huggingface_hub`. This SDK routes requests to high-speed domestic mirror nodes for multi-threaded, resumable downloads of large model files.

### 2.3 Upstream Directory Auto-Creation
Since the `upstream` directory is excluded from Git via `.gitignore`, the installer must automatically create this directory before cloning. The `create_upstream_dir()` function in `install_backend.py` handles this dynamically using `pathlib` to ensure the parent folder structure is fully initialized before the `git clone` command executes.

### 2.4 Dynamic GPU/CUDA Hardware Detection
Detecting NVIDIA graphics cards in PowerShell:

```powershell
# 1. 默认设置 PyTorch 额外索引为 CPU
$torchExtraUrl = "https://download.pytorch.org/whl/cpu"
$hasGpu = $false

# 2. 查询 CIM 实例检查 NVIDIA 独立显卡
try {
    $gpuList = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    foreach ($gpu in $gpuList) {
        if ($gpu.Name -like "*NVIDIA*") {
            $hasGpu = $true
            $torchExtraUrl = "https://download.pytorch.org/whl/cu121"
            break
        }
    }
} catch {
    # 3. 备用检测：若 CIM 查询失败，尝试通过 nvidia-smi
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        $hasGpu = $true
        $torchExtraUrl = "https://download.pytorch.org/whl/cu121"
    }
}
```

### 2.5 Reconstructed Startup and Shutdown Control
The startup (`run.bat`) and shutdown (`shutdown.bat`) scripts are fully refactored to work in synergy with the `install.bat` environment:
*   **`run.bat`**: Activates the isolated `.venv` and launches the optional test/debug WebUI on port `8090` or the production API service on port `4323` (`server/tts_server.py`).
*   **`shutdown.bat`**: Scans the system for processes listening on ports `4323` and `8090` and terminates them cleanly using native Windows command-line tools.

### 2.6 Robust Cleanup of Legacy Residuals (Safe Remove)
To prevent permission deadlocks when cleaning up legacy virtual environments (`.venv`) or upstream repositories (`upstream`), the script implements a robust deletion mechanism:
1. **Process Lock Prevention**: Before executing any folder deletion, the script must execute `shutdown.bat` to kill any Python processes that might be occupying or locking files in the directory.
2. **Read-Only Attribute Removal**: Git object pack files in Windows frequently have read-only attributes, causing direct `shutil.rmtree()` to fail with `PermissionError`. To resolve this, we register a custom `remove_readonly` error handler with `shutil.rmtree(..., onerror=remove_readonly)`.
3. **Pathlib Compliance**: In accordance with the project-wide `pathlib` specification, the `remove_readonly` callback uses `pathlib.Path(path).chmod(stat.S_IWRITE)` instead of `os.chmod`.

# 这是一个超过 10 行 of Python 代码块，具体展示了 pathlib 驱动的只读文件属性修改与安全目录删除机制
```python
import stat
import shutil
from pathlib import Path


def remove_readonly(func, path, excinfo):
    # 使用 pathlib.Path 代替 os.chmod 修改只读属性
    Path(path).chmod(stat.S_IWRITE)
    func(path)


def safe_remove_directory(target_dir: Path) -> None:
    # 安全删除指定目录，注册只读文件处理回调
    if target_dir.exists():
        print(f"正在安全删除目录: {target_dir}")
        shutil.rmtree(str(target_dir), onerror=remove_readonly)
```
```

---

## 3. Installation Backend Logic Flow and Script Design

The following is the internal function organization and logical framework of `install_backend.py` (strictly adhering to Python coding standards and comment guidelines):

# 这是一个超过 10 行 of Python 代码块，具体展示了高可用 PyTorch 部署、Wheel 强行覆盖安装以及 Hugging Face 镜像并发下载的后端实现逻辑
```python
import stat
import shutil
import subprocess
import sys
from pathlib import Path


def remove_readonly(func, path, excinfo):
    # 使用 pathlib.Path 代替 os.chmod 修改只读属性
    Path(path).chmod(stat.S_IWRITE)
    func(path)


def safe_remove_directory(target_dir: Path) -> None:
    # 安全删除指定目录，注册只读文件处理回调
    if target_dir.exists():
        print(f"正在安全删除目录: {target_dir}")
        shutil.rmtree(str(target_dir), onerror=remove_readonly)


def install_pyworld_whl(uv_path: Path) -> None:
    # 集中定义 pyworld 在 Win-amd64-py310 下 of 官方归档与阿里云镜像 Wheel 地址
    primary_whl = "https://github.com/cgohlke/winpython-wheels/releases/download/v2023.2.0/pyworld-0.3.4-cp310-cp310-win_amd64.whl"
    backup_whl = "https://mirrors.aliyun.com/pypi/packages/cp310/p/pyworld/pyworld-0.3.4-cp310-cp310-win_amd64.whl"
    # 下面是一个超过10行的代码块，首先尝试常规安装，若常规安装失败（如网络、源未同步等）或触发源码编译，则捕获异常并使用预编译 Wheel 进行强行覆盖安装以规避 C++ 编译
    try:
        print("尝试通过常规渠道安装 pyworld 依赖...")
        subprocess.check_call([str(uv_path), "pip", "install", "pyworld"])
    except subprocess.CalledProcessError:
        print("常规渠道安装失败，正在回退至第一预编译 Wheel 强行安装...")
        try:
            subprocess.check_call([str(uv_path), "pip", "install", primary_whl])
        except subprocess.CalledProcessError:
            print("第一预编译 Wheel 下载或安装超时，立即回退至阿里云镜像源 Wheel 进行强行安装...")
            subprocess.check_call([str(uv_path), "pip", "install", backup_whl])


def ensure_requirements_installed(venv_py: Path, extra_url: str) -> None:
    # 获取当前工作目录并动态拼接相关路径
    root_dir = Path(__file__).resolve().parent
    requirements_file = root_dir / "requirements-inference.txt"
    uv_path = root_dir / ".venv" / "Scripts" / "uv.exe"
    # 下面是一个超过10行的代码块，完成硬件自适应 PyTorch 包部署、高可用 pyworld 安装，以及常规依赖批量安装
    print("正在安装硬件匹配的 PyTorch 基础包...")
    subprocess.check_call([
        str(venv_py), "-m", "pip", "install",
        "torch==2.5.1", "torchaudio==2.5.1",
        "--extra-index-url", extra_url
    ])
    print("正在执行高可用 pyworld 安装方案...")
    install_pyworld_whl(uv_path)
    print("正在通过 uv 极速部署 PilotTTS 常规依赖项...")
    subprocess.check_call([
        str(uv_path), "pip", "install", "-r", str(requirements_file)
    ])


def download_hf_models(venv_py: Path) -> None:
    # 动态构建并初始化本地模型权重下载路径
    root_dir = Path(__file__).resolve().parent
    upstream_dir = root_dir / "upstream"
    weights_dir = upstream_dir / "pretrained_models"
    weights_dir.mkdir(parents=True, exist_ok=True)
    # 下面是一个超过10行的代码块，构建 Hugging Face 权重并发高速下载逻辑
    script_content = f"""
from pathlib import Path
from huggingface_hub import snapshot_download
weights_path = Path(r"{weights_dir}")
print("开始下载 AmapVoice/PilotTTS 语音权重...")
snapshot_download("AmapVoice/PilotTTS", local_dir=weights_path, max_workers=4)
print("开始下载 facebook/w2v-bert-2.0 基础权重...")
snapshot_download("facebook/w2v-bert-2.0", local_dir=weights_path / "w2v-bert-2.0", max_workers=4)
"""
    print("正在注入 Hugging Face 国内镜像源，启动 3-5 GB 权重高速并发下载...")
    subprocess.check_call([str(venv_py), "-c", script_content])


if __name__ == "__main__":
    print("安装后端流程已加载。")
```

---

## 4. Reconstructed Batch Scripts Design

### 4.1 Startup Script (`run.bat`)

**Architecture separation** (do not conflate with ChattingCursor production):

| Mode | Command | Process | Port | Used by |
|------|---------|---------|------|---------|
| Default (test/debug) | `run.bat` | `upstream/webui.py` | `8090` | Standalone Gradio UI |
| Manual API test | `run.bat api` | `server/tts_server.py` | `4323` | Developers / ops |
| Production read-aloud | Bridge `pilot-tts-spawn.ts` | `server/tts_server.py` | `4323` | ChattingCursor `/tts/synthesize` |
| Optional config UI | Bridge `POST /tts/webui/start` | `upstream/webui.py` | `8090` | Voice settings page |

The startup script ensures environment isolation and targets unified ports:

```batch
@echo off
:: 切换到当前脚本所在的目录
cd /d "%~dp0"

:: 检查虚拟环境和 upstream 目录是否存在
if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Virtual environment not found. Please run install.bat first.
    pause
    exit /b 1
)
if not exist "upstream\webui.py" (
    echo [ERROR] Upstream source files not found. Please run install.bat first.
    pause
    exit /b 1
)

:: 默认 WebUI 8090；api 参数手动测 4323 sidecar（生产由 Bridge 拉起）
if "%1"=="api" (
    set "PILOT_TTS_PORT=4323"
    set "PILOT_TTS_AUTO_LOAD=0"
    .venv\Scripts\python.exe server\tts_server.py
) else (
    cd upstream
    set "GRADIO_SERVER_NAME=127.0.0.1"
    set "GRADIO_SERVER_PORT=8090"
    set "SERVER_NAME=127.0.0.1"
    set "SERVER_PORT=8090"
    ..\.venv\Scripts\python.exe webui.py --port 8090
)
```

### 4.2 Shutdown Script (`shutdown.bat`)
The shutdown script scans and terminates processes occupying the specified ports:

```batch
@echo off
:: 切换到当前脚本所在的目录
cd /d "%~dp0"

:: 查找并杀死占用 4323 端口（API 服务）的进程
echo 正在停止运行在端口 4323 的 API 服务...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :4323 ^| findstr LISTENING') do (
    taskkill /f /pid %%a
)

:: 查找并杀死占用 8090 端口（WebUI 测试/调试界面）的进程
echo 正在停止运行在端口 8090 的 WebUI 服务...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8090 ^| findstr LISTENING') do (
    taskkill /f /pid %%a
)

echo 服务已成功停止。
```
