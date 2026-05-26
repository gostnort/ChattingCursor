# 一键启动：Bridge + cloudflared 快速隧道，自动写入 token 文件中的 publicBridgeUrl
param(
  [int]$BridgePort = 4321,
  [string]$TokenSyncDir = "$HOME\ChattingCursorTokenSync"
)

$ErrorActionPreference = "Continue"
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch {
  # 非交互环境可能无法设置控制台编码
}
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$script:BridgeProcess = $null
$script:BridgeOwned = $false
$script:TunnelProcess = $null
$script:TunnelLogPath = Join-Path $env:TEMP "chattingcursor-cloudflared.log"
$script:TunnelUrlApplied = $false
$script:DetectedTunnelUrl = $null
$script:ShuttingDown = $false
$script:TunnelLogOffset = 0
$TunnelUrlPattern = [regex]"https://[a-z0-9-]+\.trycloudflare\.com"


function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message"
}


function Write-Ok([string]$Message) {
  Write-Host "[OK] $Message"
}


function Write-Fail([string]$Message) {
  Write-Host "[FAIL] $Message"
}


function Resolve-CloudflaredExe {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
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
  if (-not (Test-Path "$Root\packages\cli-client\dist")) {
    Write-Step "构建 cli-client（Bridge 依赖）..."
    pnpm --filter @chatting-cursor/cli-client build
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  }
  if (-not (Test-Path "$Root\packages\orchestrator\dist")) {
    Write-Step "构建 orchestrator（Bridge 依赖）..."
    pnpm --filter @chatting-cursor/orchestrator build
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  }
}


function Resolve-PnpmExe {
  $cmd = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  $cmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  return "pnpm"
}


function Stop-ChildProcesses {
  if ($script:TunnelProcess -and -not $script:TunnelProcess.HasExited) {
    try {
      & taskkill /PID $script:TunnelProcess.Id /T /F *>$null
    } catch {
      # 隧道进程可能已退出
    }
    $script:TunnelProcess = $null
  }
  if ($script:BridgeOwned -and $script:BridgeProcess -and -not $script:BridgeProcess.HasExited) {
    try {
      & taskkill /PID $script:BridgeProcess.Id /T /F *>$null
    } catch {
      # Bridge 进程可能已退出
    }
    $script:BridgeProcess = $null
  }
}


function Get-TokenFilePath {
  return Join-Path $TokenSyncDir "chattingcursor-token.txt"
}


function Test-TokenFileHasTrycloudflareUrl {
  param([string]$FilePath = (Get-TokenFilePath))
  if (-not (Test-Path $FilePath)) {
    return $false
  }
  $content = Get-Content -Path $FilePath -Raw -ErrorAction SilentlyContinue
  if (-not $content) {
    return $false
  }
  return $TunnelUrlPattern.IsMatch($content)
}


function Get-TokenFilePublicUrl {
  param([string]$FilePath = (Get-TokenFilePath))
  if (-not (Test-Path $FilePath)) {
    return $null
  }
  foreach ($line in Get-Content -Path $FilePath -ErrorAction SilentlyContinue) {
    if ($line -match '^\s*publicBridgeUrl:\s*(.+)\s*$') {
      return $Matches[1].Trim().TrimEnd("/")
    }
  }
  return $null
}


function Write-PublicBridgeUrlToTokenFileDirect([string]$PublicUrl) {
  $filePath = Get-TokenFilePath
  $dir = Split-Path -Parent $filePath
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $content = ""
  if (Test-Path $filePath) {
    $content = Get-Content -Path $filePath -Raw -ErrorAction SilentlyContinue
  }
  if ([string]::IsNullOrWhiteSpace($content)) {
    $today = (Get-Date).ToString("yyyy-MM-dd")
    $content = @(
      "date: $today",
      "token: PENDING_SYNC_FROM_BRIDGE",
      "generatedAt: $((Get-Date).ToUniversalTime().ToString('o'))",
      "publicBridgeUrl: $PublicUrl",
      ""
    ) -join "`n"
  } else {
    $replaced = $false
    $lines = $content -split '\r?\n'
    $updated = foreach ($line in $lines) {
      if ($line -match '^\s*publicBridgeUrl:') {
        $replaced = $true
        "publicBridgeUrl: $PublicUrl"
      } else {
        $line
      }
    }
    if (-not $replaced) {
      $updated = @("publicBridgeUrl: $PublicUrl") + $updated
    }
    $content = ($updated -join "`n").TrimEnd() + "`n"
  }
  Set-Content -Path $filePath -Value $content -Encoding utf8
}


function Set-PublicBridgeUrlInTokenFile([string]$PublicUrl) {
  if ($script:TunnelUrlApplied) {
    return $true
  }
  $normalized = $PublicUrl.Trim().TrimEnd("/")
  $body = @{ publicBridgeUrl = $normalized } | ConvertTo-Json
  $apiOk = $false
  try {
    $response = Invoke-RestMethod `
      -Uri "http://127.0.0.1:$BridgePort/local/public-bridge-url" `
      -Method Post `
      -ContentType "application/json; charset=utf-8" `
      -Body $body `
      -ErrorAction Stop
    $apiOk = $true
    Write-Ok "Bridge API 已写入 publicBridgeUrl: $($response.publicBridgeUrl)"
    Write-Host "     Token 文件: $($response.tokenFilePath)"
  } catch {
    Write-Fail "Bridge API 写入失败: $($_.Exception.Message)"
    Write-Host "     将尝试直接写入 token 文件..."
    try {
      Write-PublicBridgeUrlToTokenFileDirect -PublicUrl $normalized
      Write-Ok "已直接写入 token 文件（API 回退）"
    } catch {
      Write-Fail "直接写入 token 文件也失败: $($_.Exception.Message)"
      return $false
    }
  }
  if (-not (Test-TokenFileHasTrycloudflareUrl)) {
    Write-Fail "token 文件中未找到 trycloudflare 公网地址"
    return $false
  }
  $onDisk = Get-TokenFilePublicUrl
  Write-Ok "token 文件已包含公网 URL: $onDisk"
  $script:TunnelUrlApplied = $true
  Write-Host ""
  Write-Host "手机配置: GitHub Pages -> 本地 -> 配置"
  Write-Host "  Bridge URL = $onDisk"
  Write-Host "  今日口令 = 从 token 文件复制"
  Write-Host ""
  return $true
}


function Test-PublicBridgeHealth([string]$PublicUrl) {
  $healthUrl = "$PublicUrl/health"
  for ($attempt = 1; $attempt -le 6; $attempt++) {
    try {
      $resp = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 15 -ErrorAction Stop
      if ($resp.status -eq "ok") {
        Write-Ok "公网健康检查通过: $healthUrl"
        return $true
      }
      Write-Fail "公网健康检查返回异常: $healthUrl"
      return $false
    } catch {
      if ($attempt -lt 6) {
        Write-Host "公网健康检查第 ${attempt} 次失败，5s 后重试..."
        Start-Sleep -Seconds 5
      } else {
        Write-Fail "公网健康检查失败（隧道 URL 已写入 token 文件，手机端可稍后再试）: $($_.Exception.Message)"
        return $false
      }
    }
  }
  return $false
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
  if ($script:DetectedTunnelUrl -eq $url) {
    return
  }
  $script:DetectedTunnelUrl = $url
  Write-Ok "检测到 cloudflared 隧道地址: $url"
  $null = Set-PublicBridgeUrlInTokenFile -PublicUrl $url
  if ($script:TunnelUrlApplied) {
    $null = Test-PublicBridgeHealth -PublicUrl $url
  }
}


function Poll-TunnelOutput {
  if (-not $script:TunnelProcess -or $script:TunnelProcess.HasExited) {
    return
  }
  try {
    foreach ($reader in @($script:TunnelProcess.StandardOutput, $script:TunnelProcess.StandardError)) {
      if (-not $reader) {
        continue
      }
      while ($reader.Peek() -ge 0) {
        $line = $reader.ReadLine()
        if ($line) {
          Write-Host ('[tunnel] ' + $line)
          Invoke-TunnelLine -Line $line
        }
      }
    }
  } catch {
    # 流可能暂时不可读
  }
}


function Read-TunnelLogNewLines {
  if (-not (Test-Path $script:TunnelLogPath)) {
    return
  }
  try {
    $stream = [System.IO.File]::Open($script:TunnelLogPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $stream.Seek($script:TunnelLogOffset, [System.IO.SeekOrigin]::Begin) | Out-Null
      $reader = New-Object System.IO.StreamReader($stream)
      while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        if ($line) {
          Write-Host ('[tunnel] ' + $line)
          Invoke-TunnelLine -Line $line
        }
      }
      $script:TunnelLogOffset = $stream.Position
    } finally {
      $stream.Dispose()
    }
  } catch {
    # 日志可能正被 cloudflared 写入，下一轮再读
  }
}


function Wait-BridgeReady {
  param([int]$MaxSeconds = 120)
  $healthUrl = "http://127.0.0.1:$BridgePort/health"
  for ($i = 0; $i -lt $MaxSeconds; $i++) {
    try {
      $null = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2 -ErrorAction Stop
      return $true
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  if ($script:BridgeProcess -and $script:BridgeProcess.HasExited) {
    Write-Fail "Bridge 启动进程已退出，代码: $($script:BridgeProcess.ExitCode)"
  } else {
    Write-Fail "Bridge 在 ${MaxSeconds}s 内未通过 /health 检查"
  }
  return $false
}


function Get-ListenerPids([int]$Port) {
  $pids = @()
  try {
    $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    # Get-NetTCPConnection 不可用时回退 netstat
  }
  if ($pids.Count -eq 0) {
    $pattern = (':{0}\s' -f $Port)
    $lines = netstat -ano -p tcp 2>$null | Select-String "LISTENING" | Select-String $pattern
    foreach ($line in $lines) {
      $parts = ($line.ToString().Trim() -split '\s+')
      if ($parts.Length -ge 1) {
        $pidText = $parts[-1]
        if ($pidText -match '^\d+$') {
          $pids += [int]$pidText
        }
      }
    }
    $pids = @($pids | Select-Object -Unique)
  }
  return $pids
}


function Test-PortInUse([int]$Port) {
  return (Get-ListenerPids -Port $Port).Count -gt 0
}


function Clear-StaleBridgePort {
  param([int]$MaxWaitSeconds = 20)
  Write-Host ""
  Write-Host "端口 $BridgePort 已被占用，正在尝试清理残留进程..."
  Write-Host "（也可先运行 shutdown.bat）"
  Write-Host ""
  & "$PSScriptRoot\shutdown-all.ps1" -SkipWeb
  $deadline = (Get-Date).AddSeconds($MaxWaitSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-PortInUse -Port $BridgePort)) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  return -not (Test-PortInUse -Port $BridgePort)
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
  # Windows：勿对 pnpm.cmd 使用 stdout 重定向；用 Start-Process 保持 dev 子进程存活
  $env:CHATTINGCURSOR_TOKEN_SYNC_DIR = $TokenSyncDir
  $env:BRIDGE_PUBLIC_URL = "http://127.0.0.1:$BridgePort"
  $env:BRIDGE_PORT = "$BridgePort"
  $pnpmExe = Resolve-PnpmExe
  $script:BridgeProcess = Start-Process -FilePath $pnpmExe -ArgumentList "dev:bridge" -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  $script:BridgeOwned = $true
  Write-Host "Bridge 进程 PID: $($script:BridgeProcess.Id) (pnpm: $pnpmExe)"
}


function Start-TunnelProcess {
  $cloudflaredExe = Resolve-CloudflaredExe
  if (-not $cloudflaredExe) {
    throw "未找到 cloudflared 可执行文件"
  }
  if (Test-Path $script:TunnelLogPath) {
    Remove-Item $script:TunnelLogPath -Force -ErrorAction SilentlyContinue
  }
  $script:TunnelLogOffset = 0
  # cloudflared 主要写 stderr；重定向到日志文件避免管道缓冲区塞满导致进程退出
  $tunnelCmd = "`"$cloudflaredExe`" tunnel --url http://127.0.0.1:$BridgePort"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "cmd.exe"
  $psi.Arguments = "/c $tunnelCmd > `"$($script:TunnelLogPath)`" 2>&1"
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $script:TunnelProcess = [System.Diagnostics.Process]::Start($psi)
  Write-Host "cloudflared: $cloudflaredExe"
  Write-Host "隧道日志: $($script:TunnelLogPath)"
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
  # 非交互终端无法注册 Ctrl+C
}

$exitCode = 0
try {
  Write-Host "=== ChattingCursor 远程启动 ==="
  Write-Host "Token 同步目录: $TokenSyncDir"
  Write-Host "Token 文件: $(Get-TokenFilePath)"
  Write-Host "Stop: press Ctrl+C"
  Write-Host ""

  Ensure-ProjectReady

  if (-not (Test-CloudflaredInstalled)) {
    Write-Fail "未找到 cloudflared，请先运行 install.bat"
    exit 1
  }
  Write-Ok "cloudflared 已找到: $(Resolve-CloudflaredExe)"

  if (Test-PortInUse -Port $BridgePort) {
    if (Test-BridgeHealthy) {
      Write-Ok "端口 $BridgePort 上已有健康的 Bridge，将复用现有实例。"
    } elseif (-not (Clear-StaleBridgePort)) {
      $stalePids = @(Get-ListenerPids -Port $BridgePort)
      Write-Fail "端口 $BridgePort 仍被占用 (PID: $($stalePids -join ', '))"
      Write-Host "请先运行 shutdown.bat，或手动结束上述进程后再运行 run.bat。"
      exit 2
    } else {
      Write-Ok "端口 $BridgePort 已释放"
    }
  }

  if (-not (Test-BridgeHealthy)) {
    Write-Step "启动 Bridge (端口 $BridgePort)..."
    Start-BridgeProcess
    if (-not (Wait-BridgeReady)) {
      Write-Fail "Bridge 在限定时间内未就绪；可先运行 shutdown.bat 后重试。"
      exit 1
    }
  }
  Write-Ok "Bridge 本地健康: http://127.0.0.1:$BridgePort/health"

  Write-Step "启动 cloudflared 快速隧道..."
  Start-TunnelProcess

  $tunnelWaitSeconds = 90
  Write-Host "等待隧道 URL（最多 ${tunnelWaitSeconds}s）..."
  for ($tick = 0; $tick -lt ($tunnelWaitSeconds * 2); $tick++) {
    if ($script:ShuttingDown) {
      break
    }
    Start-Sleep -Milliseconds 500
    Read-TunnelLogNewLines
    if ($script:DetectedTunnelUrl -and -not $script:TunnelUrlApplied) {
      $null = Set-PublicBridgeUrlInTokenFile -PublicUrl $script:DetectedTunnelUrl
    }
    if ($script:TunnelUrlApplied) {
      break
    }
    if ($script:TunnelProcess -and $script:TunnelProcess.HasExited) {
      Read-TunnelLogNewLines
      Write-Fail "cloudflared 已退出，代码: $($script:TunnelProcess.ExitCode)"
      break
    }
    if ($script:BridgeOwned -and $script:BridgeProcess -and $script:BridgeProcess.HasExited -and -not (Test-BridgeHealthy)) {
      Write-Fail "Bridge 进程已退出，代码: $($script:BridgeProcess.ExitCode)"
      exit 1
    }
  }

  if (-not $script:TunnelUrlApplied) {
    Read-TunnelLogNewLines
    Write-Fail "未在 ${tunnelWaitSeconds}s 内获得 trycloudflare 地址，请查看隧道日志: $($script:TunnelLogPath)"
    exit 1
  }

  Write-Ok "启动流程完成，服务持续运行中。"
  Write-Host ""

  while (-not $script:ShuttingDown) {
    Start-Sleep -Milliseconds 500
    Read-TunnelLogNewLines
    if ($script:BridgeOwned -and $script:BridgeProcess -and $script:BridgeProcess.HasExited -and -not (Test-BridgeHealthy)) {
      Write-Fail "Bridge 进程已退出，代码: $($script:BridgeProcess.ExitCode)"
      $exitCode = 1
      break
    }
    if ($script:TunnelProcess -and $script:TunnelProcess.HasExited) {
      Read-TunnelLogNewLines
      Write-Fail "cloudflared 已退出，代码: $($script:TunnelProcess.ExitCode)"
      $exitCode = 1
      break
    }
  }
}
finally {
  Stop-ChildProcesses
}
exit $exitCode
