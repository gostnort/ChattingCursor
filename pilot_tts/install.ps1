# PilotTTS 安装核心控制器：环境预检与 uv 引导（Task 1.2）
param(
    [switch]$Reset,
    [switch]$SkipWeights
)

$ErrorActionPreference = "Stop"
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ScriptRoot


function Write-InstallLog {
    param([string]$Message)
    Write-Host $Message
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


# 主流程入口：执行环境预检与 uv 引导
Write-InstallLog "=== PilotTTS Install: Environment Preflight ==="
Ensure-EnvironmentPreflight
Write-InstallLog "=== Preflight complete ==="
