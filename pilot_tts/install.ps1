# PilotTTS 安装核心控制器：环境预检、硬件检测、虚拟环境、依赖与上游部署（Phase 1–5）
param(
    [switch]$Reset,
    [switch]$SkipWeights
)

$ErrorActionPreference = "Stop"
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ScriptRoot

# 解析 install.bat 透传的 --reset / --skip-weights 风格参数
foreach ($arg in $args) {
    switch ($arg) {
        "--reset" { $Reset = $true }
        "--skip-weights" { $SkipWeights = $true }
    }
}


function Write-InstallLog {
    param([string]$Message)
    Write-Host $Message
}


function Test-NonInteractiveInstall {
    $flag = $env:PILOT_TTS_INSTALL_NONINTERACTIVE
    if (-not $flag) {
        return $false
    }
    $normalized = $flag.Trim().ToLower()
    return $normalized -in @("1", "true", "yes")
}


function Confirm-ResetCleanup {
    if (Test-NonInteractiveInstall) {
        Write-InstallLog "[INFO] Non-interactive mode: proceeding with --reset cleanup."
        return $true
    }
    Write-Host ""
    Write-Host "[WARN] --reset will remove .venv and upstream directories." -ForegroundColor Yellow
    $answer = Read-Host "Continue with full reset? [y/N]"
    $normalized = if ($answer) { $answer.Trim().ToLower() } else { "" }
    return $normalized -in @("y", "yes")
}


function Invoke-ResetCleanup {
    # 在删除目录前执行 shutdown.bat 并调用 Python 安全清理逻辑（Task 5.2）
    Write-InstallLog "=== PilotTTS Install: Reset Cleanup (Task 5.2) ==="
    $shutdownBat = Join-Path $ScriptRoot "shutdown.bat"
    if (Test-Path -LiteralPath $shutdownBat) {
        Write-InstallLog "[INFO] Running shutdown.bat to release process locks..."
        & cmd /c "`"$shutdownBat`""
    } else {
        Write-InstallLog "[WARN] shutdown.bat not found, skipping process shutdown step."
    }
    $backendScript = Join-Path $ScriptRoot "install_backend.py"
    $venvPython = Join-Path $ScriptRoot ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $venvPython) {
        & $venvPython $backendScript --reset-only
    } else {
        Write-InstallLog "[INFO] No .venv Python found, using uv-managed Python 3.10 for cleanup..."
        & uv python install 3.10 2>$null | Out-Null
        $uvPython = (& uv python find 3.10 2>&1 | Out-String).Trim()
        if (-not $uvPython -or -not (Test-Path -LiteralPath $uvPython)) {
            Write-Host ""
            Write-Host "[ERROR] Unable to locate Python 3.10 for reset cleanup." -ForegroundColor Red
            exit 1
        }
        & $uvPython $backendScript --reset-only
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "[ERROR] Reset cleanup failed." -ForegroundColor Red
        exit 1
    }
    Write-InstallLog "=== Reset cleanup complete ==="
}


function Test-GitAvailable {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) {
        Write-Host ""
        Write-Host "[ERROR] Git is not installed or not in PATH." -ForegroundColor Red
        Write-Host "Please install Git for Windows: https://git-scm.com/download/win"
        Write-Host "Select 'Git from the command line and also from 3rd-party software' during setup."
        Write-Host "After installation, restart your shell and run install.bat again."
        exit 1
    }
    $version = & git --version
    Write-InstallLog "[OK] $version"
}


function Get-UvInstallDir {
    if ($env:UV_INSTALL_DIR) {
        return $env:UV_INSTALL_DIR
    }
    if ($env:XDG_BIN_HOME) {
        return $env:XDG_BIN_HOME
    }
    if ($env:XDG_DATA_HOME) {
        return (Join-Path $env:XDG_DATA_HOME "../bin")
    }
    $homeDir = if ($HOME) { $HOME } else { $env:USERPROFILE }
    return (Join-Path $homeDir ".local/bin")
}


function Update-SessionPath {
    param([string]$Dir)
    if (-not $Dir) {
        return
    }
    $normalizedDir = $Dir.TrimEnd('\')
    $pathEntries = $env:PATH -split ';' | Where-Object { $_ -ne '' }
    if ($pathEntries -notcontains $normalizedDir) {
        $env:PATH = "$normalizedDir;$env:PATH"
    }
}


function Test-UvAvailable {
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    return [bool]$uv
}


function Install-UvSilent {
    Write-InstallLog "[INFO] uv not found. Installing silently via official Astral installer..."
    try {
        # 通过官方 Astral PowerShell 管道静默安装 uv，并抑制安装器信息流输出
        $installScript = Invoke-RestMethod -Uri "https://astral.sh/uv/install.ps1" -UseBasicParsing
        $null = Invoke-Expression $installScript 6>$null 5>$null 4>$null 3>$null 2>$null 1>$null
    } catch {
        Write-Host ""
        Write-Host "[ERROR] Failed to install uv automatically: $_" -ForegroundColor Red
        Write-Host 'Manual install: powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 | iex"'
        exit 1
    }
    $installDir = Get-UvInstallDir
    Update-SessionPath -Dir $installDir
    if (-not (Test-UvAvailable)) {
        $uvExe = Join-Path $installDir "uv.exe"
        if (Test-Path -LiteralPath $uvExe) {
            Update-SessionPath -Dir $installDir
        }
    }
    if (-not (Test-UvAvailable)) {
        Write-Host ""
        Write-Host "[ERROR] uv was installed but is not available in the current session PATH." -ForegroundColor Red
        Write-Host "Add this directory to PATH: $installDir"
        Write-Host 'Or run: $env:Path = "' + $installDir + ';$env:Path"'
        exit 1
    }
    $version = & uv --version
    Write-InstallLog "[OK] $version (installed and ready in current session)"
}


function Ensure-EnvironmentPreflight {
    Test-GitAvailable
    if (Test-UvAvailable) {
        $version = & uv --version
        Write-InstallLog "[OK] $version"
        return
    }
    Install-UvSilent
}


function Test-NvidiaSmiAvailable {
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        return $true
    }
    $driverPaths = @(
        (Join-Path $env:ProgramFiles "NVIDIA Corporation\NVSMI\nvidia-smi.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "NVIDIA Corporation\NVSMI\nvidia-smi.exe"),
        (Join-Path $env:SystemRoot "System32\nvidia-smi.exe")
    )
    foreach ($driverPath in $driverPaths) {
        if ($driverPath -and (Test-Path -LiteralPath $driverPath)) {
            return $true
        }
    }
    return $false
}


function Get-TorchHardwareConfig {
    # 查询 Win32_VideoController 并回退至 nvidia-smi 或驱动路径以判定 NVIDIA GPU
    $torchExtraUrl = "https://download.pytorch.org/whl/cpu"
    $hasGpu = $false
    try {
        $gpuList = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
        if ($gpuList) {
            foreach ($gpu in $gpuList) {
                if ($gpu.Name -like "*NVIDIA*") {
                    $hasGpu = $true
                    break
                }
            }
        }
    } catch {
        # CIM 查询失败时保留 $hasGpu 为 false，稍后尝试备用检测
    }
    if (-not $hasGpu) {
        $hasGpu = Test-NvidiaSmiAvailable
    }
    if ($hasGpu) {
        $torchExtraUrl = "https://download.pytorch.org/whl/cu121"
        Write-InstallLog "NVIDIA GPU detected. Using CUDA 12.1 accelerated mirror source."
    } else {
        Write-InstallLog "No NVIDIA GPU detected. Gracefully falling back to CPU version of PyTorch."
    }
    return @{
        HasGpu = $hasGpu
        TorchExtraUrl = $torchExtraUrl
    }
}


function Ensure-VirtualEnvironment {
    # 使用 uv 在 pilot_tts 目录创建隔离的 Python 3.10 虚拟环境并校验 pip
    $venvDir = Join-Path $ScriptRoot ".venv"
    $pythonExe = Join-Path $venvDir "Scripts\python.exe"
    Write-InstallLog "[INFO] Creating isolated Python 3.10 virtual environment with uv..."
    & uv venv --python 3.10 $venvDir
    if (-not (Test-Path -LiteralPath $pythonExe)) {
        Write-Host ""
        Write-Host "[ERROR] Failed to create virtual environment at $venvDir" -ForegroundColor Red
        exit 1
    }
    $versionOutput = & $pythonExe --version 2>&1 | Out-String
    $versionOutput = $versionOutput.Trim()
    if ($versionOutput -notmatch "Python 3\.10\.") {
        Write-Host ""
        Write-Host "[ERROR] Virtual environment Python is not 3.10.x: $versionOutput" -ForegroundColor Red
        exit 1
    }
    Write-InstallLog "[OK] $versionOutput"
    Write-InstallLog "[INFO] Verifying and upgrading pip inside .venv..."
    & uv pip install --python $pythonExe pip --upgrade
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "[ERROR] Failed to verify or upgrade pip inside .venv" -ForegroundColor Red
        exit 1
    }
    $pipVersion = & $pythonExe -m pip --version 2>&1 | Out-String
    Write-InstallLog "[OK] $($pipVersion.Trim())"
}


# 主流程入口：处理 --reset、非交互模式，并执行环境预检与后端安装
if ($Reset) {
    if (-not (Confirm-ResetCleanup)) {
        Write-InstallLog "[INFO] Reset cancelled by user."
        exit 0
    }
    Invoke-ResetCleanup
}
if (Test-NonInteractiveInstall) {
    Write-InstallLog "[INFO] Non-interactive install mode enabled (PILOT_TTS_INSTALL_NONINTERACTIVE=1)."
}
Write-InstallLog "=== PilotTTS Install: Environment Preflight ==="
Ensure-EnvironmentPreflight
Write-InstallLog "=== Preflight complete ==="
Write-InstallLog "=== PilotTTS Install: Hardware Detection ==="
$torchConfig = Get-TorchHardwareConfig
$env:PILOT_TTS_TORCH_EXTRA_URL = $torchConfig.TorchExtraUrl
$env:PILOT_TTS_HAS_GPU = if ($torchConfig.HasGpu) { "1" } else { "0" }
Write-InstallLog "=== Hardware detection complete (extra-index: $($torchConfig.TorchExtraUrl)) ==="
Write-InstallLog "=== PilotTTS Install: Virtual Environment ==="
Ensure-VirtualEnvironment
Write-InstallLog "=== Phase 2 foundational setup complete ==="
Write-InstallLog "=== PilotTTS Install: Backend Executor (Phase 3-4) ==="
$backendScript = Join-Path $ScriptRoot "install_backend.py"
$pythonExe = Join-Path $ScriptRoot ".venv\Scripts\python.exe"
$backendArgs = @($backendScript)
if ($SkipWeights) {
    $backendArgs += "--skip-weights"
}
& $pythonExe @backendArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[ERROR] Backend installation failed." -ForegroundColor Red
    exit 1
}
Write-InstallLog "=== Backend installation complete ==="
Write-InstallLog ""
Write-InstallLog "=== PilotTTS deployment ready ==="
Write-InstallLog "API:  http://127.0.0.1:4323  (run.bat api)"
Write-InstallLog "WebUI: http://127.0.0.1:8090  (run.bat, test/debug only)"
if (-not (Test-NonInteractiveInstall)) {
    Write-InstallLog ""
    Write-InstallLog "Installation complete. Run run.bat to start the WebUI."
}
