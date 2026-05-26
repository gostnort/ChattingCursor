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
$script:TunnelJob = $null
$script:TunnelUrlApplied = $false
$script:DetectedTunnelUrl = $null
$script:ShuttingDown = $false
$TunnelUrlPattern = [regex]"https://[a-z0-9-]+\.trycloudflare\.com"


function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message"
}


function Resolve-CloudflaredExe {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  # winget 默认装到 Program Files (x86)\cloudflared，不一定在 PATH
  $candidates = @(
    "$env:ProgramFiles\Cloudflare\cloudflared\cloudflared.exe",
    "${env:ProgramFiles(x86)}\Cloudflare\cloudflared\cloudflared.exe",
    "$env:ProgramFiles\cloudflared\cloudflared.exe",
    "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe"
  )
  foreach ($path in $candidates) {
    if ($path -and (Test-Path $path)) {
      return $path
    }
  }
  return $null
}


function Test-CloudflaredInstalled {
  return [bool](Resolve-CloudflaredExe)
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
  if ($script:TunnelJob) {
    try {
      Stop-Job $script:TunnelJob -ErrorAction SilentlyContinue
      Remove-Job $script:TunnelJob -Force -ErrorAction SilentlyContinue
    } catch {
      # 后台任务可能已结束
    }
    $script:TunnelJob = $null
  }
  if ($script:BridgeProcess -and -not $script:BridgeProcess.HasExited) {
    try {
      $script:BridgeProcess.Kill($true)
    } catch {
      # 进程可能已退出
    }
  }
}


function Receive-TunnelOutput {
  if (-not $script:TunnelJob) {
    return
  }
  $lines = Receive-Job $script:TunnelJob -Keep -ErrorAction SilentlyContinue
  foreach ($line in $lines) {
    if ($null -eq $line) {
      continue
    }
    $text = $line.ToString()
    if ($text) {
      Write-Host ('[tunnel] ' + $text)
      Invoke-TunnelLine -Line $text
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
  $script:DetectedTunnelUrl = $url
  Write-Host "检测到隧道地址: $url"
  Set-PublicBridgeUrlInTokenFile -PublicUrl $url
}


function Test-BridgeHealthy {
  $healthUrl = "http://127.0.0.1:$BridgePort/health"
  try {
    $null = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2 -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
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
  $cloudflaredExe = Resolve-CloudflaredExe
  if (-not $cloudflaredExe) {
    throw "未找到 cloudflared 可执行文件"
  }
  # Windows 上 cloudflared 走 stderr，Process 异步 ReadLine 收不到；用 Job 合并 2>&1
  $script:TunnelJob = Start-Job -ScriptBlock {
    param($ExePath, $Port)
    & $ExePath tunnel --url "http://127.0.0.1:$Port" 2>&1 | ForEach-Object { $_.ToString() }
  } -ArgumentList $cloudflaredExe, $BridgePort
  return $script:TunnelJob
}


try {
  [Console]::TreatControlCAsInput = $false
  [Console]::CancelKeyPress.Add({
    param($sender, $e)
    $e.Cancel = $true
    $script:ShuttingDown = $true
    Write-Host ""
    Write-Host "正在停止 Bridge 与隧道..."
    Stop-ChildProcesses
  }) | Out-Null
} catch {
  # 非交互终端无法注册 Ctrl+C，依赖进程退出或外部结束
}

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
    Receive-TunnelOutput
    if ($script:DetectedTunnelUrl -and -not $script:TunnelUrlApplied) {
      Set-PublicBridgeUrlInTokenFile -PublicUrl $script:DetectedTunnelUrl
    }
    if ($script:BridgeProcess -and $script:BridgeProcess.HasExited -and -not (Test-BridgeHealthy)) {
      Write-Host "Bridge 进程已退出，代码: $($script:BridgeProcess.ExitCode)"
      break
    }
    if ($script:TunnelJob -and $script:TunnelJob.State -in @("Failed", "Stopped", "Completed")) {
      Receive-TunnelOutput
      Write-Host "cloudflared 已退出，状态: $($script:TunnelJob.State)"
      break
    }
  }
}
finally {
  Stop-ChildProcesses
}
