# 一键启动：Bridge + cloudflared 快速隧道，自动写入 token 文件中的 publicBridgeUrl
param(
  [int]$BridgePort = 4321,
  [string]$TokenSyncDir = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Resolve-TokenSyncDir.ps1")
$TokenSyncDir = Resolve-TokenSyncDir -Override $TokenSyncDir
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$script:BridgeProcess = $null
$script:TunnelProcess = $null
$script:TunnelUrlApplied = $false
$TunnelUrlPattern = [regex]"https://[a-z0-9-]+\.trycloudflare\.com"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message"
}


function Test-CloudflaredInstalled {
  return [bool](Get-Command cloudflared -ErrorAction SilentlyContinue)
}


function Ensure-ProjectReady {
  if (-not (Test-Path "$Root\node_modules")) {
    Write-Step "首次运行，正在安装依赖..."
    & "$PSScriptRoot\install-all.ps1" -SkipCloudflared
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  }
  if (-not (Test-Path "$Root\packages\shared\dist")) {
    Write-Step "构建 shared 包..."
    pnpm --filter @chatting-cursor/shared build
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  }
}


function Stop-ChildProcesses {
  foreach ($proc in @($script:TunnelProcess, $script:BridgeProcess)) {
    if ($proc -and -not $proc.HasExited) {
      try {
        $proc.Kill($true)
      } catch {
        # 进程可能已退出
      }
    }
  }
}


function Wait-BridgeReady {
  param([int]$MaxSeconds = 90)
  $healthUrl = "http://127.0.0.1:$BridgePort/health"
  for ($i = 0; $i -lt $MaxSeconds; $i++) {
    try {
      $null = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
      return $true
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  return $false
}

