# 一键启动：Bridge + cloudflared 快速隧道，自动写入 token 文件中的 publicBridgeUrl
param(
  [int]$BridgePort = 4321,
  [string]$TokenSyncDir = "$HOME\ChattingCursorTokenSync"
)

# Stop 会让异步 stdout 回调里的异常直接终止脚本；主流程用 Continue，关键步骤自行检查
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$script:BridgeProcess = $null
$script:TunnelProcess = $null
$script:TunnelUrlApplied = $false
$script:ShuttingDown = $false
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
      $null = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2 -ErrorAction Stop
      return $true
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  return $false
}


function Set-PublicBridgeUrlInTokenFile([string]$PublicUrl) {
  if ($script:TunnelUrlApplied) {
    return
  }
  $body = @{ publicBridgeUrl = $PublicUrl } | ConvertTo-Json
  try {
    $response = Invoke-RestMethod `
      -Uri "http://127.0.0.1:$BridgePort/local/public-bridge-url" `
      -Method Post `
      -ContentType "application/json; charset=utf-8" `
      -Body $body `
      -ErrorAction Stop
    $script:TunnelUrlApplied = $true
    Write-Host ""
    Write-Host "已写入 token 文件。"
    Write-Host "公网 Bridge URL: $($response.publicBridgeUrl)"
    Write-Host "Token 文件路径: $($response.tokenFilePath)"
    Write-Host ""
    Write-Host "手机配置: 打开 GitHub Pages -> 本地 -> 配置"
    Write-Host "  Bridge URL = 上面公网地址"
    Write-Host "  今日口令 = 从 token 文件复制"
    Write-Host ""
  } catch {
    Write-Host "写入 token 文件失败: $($_.Exception.Message)"
  }
}


function Invoke-TunnelLine([string]$Line) {
  if ($script:TunnelUrlApplied -or [string]::IsNullOrWhiteSpace($Line)) {
    return
  }
  $match = $TunnelUrlPattern.Match($Line)
  if (-not $match.Success) {
    return
  }
  $url = $match.Value.TrimEnd("/")
  Write-Host "检测到隧道地址: $url"
  Set-PublicBridgeUrlInTokenFile -PublicUrl $url
}


function Start-BridgeProcess {
  $env:CHATTINGCURSOR_TOKEN_SYNC_DIR = $TokenSyncDir
  $env:BRIDGE_PUBLIC_URL = "http://127.0.0.1:$BridgePort"
  $env:BRIDGE_PORT = "$BridgePort"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "cmd.exe"
  $psi.Arguments = "/c pnpm dev:bridge"
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $script:BridgeProcess = $proc
  $proc.add_OutputDataReceived({
    param($sender, $e)
    try {
      if ($e.Data) {
        Write-Host ('[bridge] ' + $e.Data)
      }
    } catch {
      # 异步回调中的错误不能终止主脚本
    }
  })
  $proc.add_ErrorDataReceived({
    param($sender, $e)
    try {
      if ($e.Data) {
        Write-Host ('[bridge] ' + $e.Data)
      }
    } catch {
      # 异步回调中的错误不能终止主脚本
    }
  })
  $proc.BeginOutputReadLine()
  $proc.BeginErrorReadLine()
}


function Start-TunnelProcess {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "cloudflared"
  $psi.Arguments = "tunnel --url http://127.0.0.1:$BridgePort"
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $script:TunnelProcess = $proc
  $proc.add_OutputDataReceived({
    param($sender, $e)
    try {
      Invoke-TunnelLine -Line $e.Data
    } catch {
      # 异步回调中的错误不能终止主脚本
    }
  })
  $proc.add_ErrorDataReceived({
    param($sender, $e)
    try {
      Invoke-TunnelLine -Line $e.Data
    } catch {
      # 异步回调中的错误不能终止主脚本
    }
  })
  $proc.BeginOutputReadLine()
  $proc.BeginErrorReadLine()
  return $proc
}


[Console]::TreatControlCAsInput = $false
[Console]::CancelKeyPress.Add({
  param($sender, $e)
  $e.Cancel = $true
  $script:ShuttingDown = $true
  Write-Host ""
  Write-Host "正在停止 Bridge 与隧道..."
  Stop-ChildProcesses
}) | Out-Null

try {
  Write-Host "=== ChattingCursor 远程启动 ==="
  Write-Host "Token 同步目录: $TokenSyncDir"
  Write-Host "Stop: press Ctrl+C"
  Write-Host ""

  Ensure-ProjectReady

  if (-not (Test-CloudflaredInstalled)) {
    Write-Host "未找到 cloudflared。请先运行 install.bat"
    exit 1
  }

  Write-Step "启动 Bridge (端口 $BridgePort)..."
  Start-BridgeProcess

  if (-not (Wait-BridgeReady)) {
    Write-Host "Bridge 在限定时间内未就绪，请检查上方日志。"
    exit 1
  }
  Write-Host "Bridge 已就绪。"

  $tokenFile = Join-Path $TokenSyncDir "chattingcursor-token.txt"
  Write-Host "Token 文件（启动后自动更新 publicBridgeUrl）: $tokenFile"

  Write-Step "启动 cloudflared 快速隧道..."
  $null = Start-TunnelProcess

  # 保持脚本运行，直到用户 Ctrl+C 或子进程退出
  while (-not $script:ShuttingDown) {
    Start-Sleep -Milliseconds 500
    if ($script:BridgeProcess -and $script:BridgeProcess.HasExited) {
      Write-Host "Bridge 进程已退出，代码: $($script:BridgeProcess.ExitCode)"
      break
    }
    if ($script:TunnelProcess -and $script:TunnelProcess.HasExited) {
      Write-Host "cloudflared 已退出，代码: $($script:TunnelProcess.ExitCode)"
      break
    }
  }
}
finally {
  Stop-ChildProcesses
}
