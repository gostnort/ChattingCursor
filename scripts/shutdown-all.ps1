# 停止 ChattingCursor 相关后台服务（Bridge、cloudflared、可选 Web）
param(
  [int]$BridgePort = 4321,
  [int]$WebPort = 43210,
  [switch]$SkipWeb
)

$ErrorActionPreference = "Continue"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RootPattern = [regex]::Escape($Root)
$StoppedBridge = $false
$StoppedCloudflared = $false
$StoppedWeb = $false


function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message"
}


function Get-ProcessCommandLine([int]$ProcessId) {
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    return $proc.CommandLine
  } catch {
    return $null
  }
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
    $pattern = ":$Port\s"
    $lines = netstat -ano -p tcp 2>$null | Select-String "LISTENING" | Select-String $pattern
    foreach ($line in $lines) {
      $parts = ($line.ToString().Trim() -split "\s+")
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


function Test-BridgeCommandLine([string]$CommandLine) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return $false
  }
  if ($CommandLine -notmatch $RootPattern) {
    return $false
  }
  return (
    $CommandLine -match 'dev:bridge|@chatting-cursor/bridge|apps\\bridge|tsx watch src\\index\.ts'
  )
}


function Test-WebCommandLine([string]$CommandLine) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return $false
  }
  if ($CommandLine -notmatch $RootPattern) {
    return $false
  }
  return (
    $CommandLine -match 'dev:web|@chatting-cursor/web|apps\\web|\bvite\b'
  )
}


function Test-CloudflaredCommandLine([string]$CommandLine) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return $false
  }
  $cl = $CommandLine.ToLowerInvariant()
  if ($cl -notmatch 'cloudflared') {
    return $false
  }
  if ($cl -notmatch 'tunnel') {
    return $false
  }
  $portPattern = "127\.0\.0\.1:$BridgePort|:$BridgePort\b"
  return (
    ($cl -match $portPattern) -or
    ($cl -match 'chattingcursor-bridge') -or
    ($CommandLine -match $RootPattern)
  )
}


function Test-RunAllHostCommandLine([string]$CommandLine) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return $false
  }
  return (
    $CommandLine -match 'run-all\.ps1' -and
    $CommandLine -match $RootPattern
  )
}


function Stop-ProcessSafe([int]$ProcessId, [string]$Label) {
  if ($ProcessId -le 0) {
    return $false
  }
  try {
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) {
      return $false
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    Write-Host "  已结束 $Label (PID $ProcessId)"
    return $true
  } catch {
    try {
      & taskkill /PID $ProcessId /T /F *>$null
      if ($LASTEXITCODE -eq 0) {
        Write-Host "  已结束 $Label (PID $ProcessId，含子进程)"
        return $true
      }
    } catch {
      # taskkill 失败则忽略
    }
    Write-Host "  无法结束 $Label (PID $ProcessId): $($_.Exception.Message)"
    return $false
  }
}


function Get-AllCandidateProcesses() {
  $items = @()
  try {
    $items = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  } catch {
    return @()
  }
  return $items
}


Write-Host "=== ChattingCursor 停止服务 ==="
Write-Host "项目目录: $Root"
Write-Host ""

$candidatePids = @{}
$processes = Get-AllCandidateProcesses

foreach ($proc in $processes) {
  $procId = [int]$proc.ProcessId
  if ($procId -le 4) {
    continue
  }
  $cmd = $proc.CommandLine
  $name = $proc.Name
  if (Test-BridgeCommandLine -CommandLine $cmd) {
    $candidatePids[$procId] = "Bridge"
  }
  if (Test-WebCommandLine -CommandLine $cmd) {
    $candidatePids[$procId] = "Web"
  }
  if (($name -match 'cloudflared') -and (Test-CloudflaredCommandLine -CommandLine $cmd)) {
    $candidatePids[$procId] = "cloudflared"
  }
  if (Test-RunAllHostCommandLine -CommandLine $cmd) {
    $candidatePids[$procId] = "run-all"
  }
}

foreach ($procId in (Get-ListenerPids -Port $BridgePort)) {
  $cmd = Get-ProcessCommandLine -ProcessId $procId
  if (Test-BridgeCommandLine -CommandLine $cmd) {
    $candidatePids[$procId] = "Bridge"
  }
}

if (-not $SkipWeb) {
  foreach ($procId in (Get-ListenerPids -Port $WebPort)) {
    $cmd = Get-ProcessCommandLine -ProcessId $procId
    if (Test-WebCommandLine -CommandLine $cmd) {
      $candidatePids[$procId] = "Web"
    }
  }
}

Write-Step "停止 Bridge (端口 $BridgePort)..."
$bridgePids = @($candidatePids.GetEnumerator() | Where-Object { $_.Value -eq "Bridge" } | ForEach-Object { $_.Key })
if ($bridgePids.Count -eq 0) {
  Write-Host "  未发现运行中的 Bridge 进程。"
} else {
  foreach ($procId in ($bridgePids | Sort-Object -Descending)) {
    if (Stop-ProcessSafe -ProcessId $procId -Label "Bridge") {
      $StoppedBridge = $true
    }
  }
  if ($StoppedBridge) {
    Write-Host "已停止 Bridge。"
  }
}

Write-Step "停止 cloudflared 隧道..."
$cloudPids = @($candidatePids.GetEnumerator() | Where-Object { $_.Value -eq "cloudflared" } | ForEach-Object { $_.Key })
if ($cloudPids.Count -eq 0) {
  Write-Host "  未发现运行中的 cloudflared 隧道。"
} else {
  foreach ($procId in ($cloudPids | Sort-Object -Descending)) {
    if (Stop-ProcessSafe -ProcessId $procId -Label "cloudflared") {
      $StoppedCloudflared = $true
    }
  }
  if ($StoppedCloudflared) {
    Write-Host "已停止 cloudflared。"
  }
}

if (-not $SkipWeb) {
  Write-Step "停止 Web / Vite (端口 $WebPort)..."
  $webPids = @($candidatePids.GetEnumerator() | Where-Object { $_.Value -eq "Web" } | ForEach-Object { $_.Key })
  if ($webPids.Count -eq 0) {
    Write-Host "  未发现运行中的 Web 开发服务器。"
  } else {
    foreach ($procId in ($webPids | Sort-Object -Descending)) {
      if (Stop-ProcessSafe -ProcessId $procId -Label "Web") {
        $StoppedWeb = $true
      }
    }
    if ($StoppedWeb) {
      Write-Host "已停止 Web (Vite)。"
    }
  }
}

$runAllPids = @($candidatePids.GetEnumerator() | Where-Object { $_.Value -eq "run-all" } | ForEach-Object { $_.Key })
if ($runAllPids.Count -gt 0) {
  Write-Step "停止 run-all 启动脚本..."
  foreach ($procId in ($runAllPids | Sort-Object -Descending)) {
    Stop-ProcessSafe -ProcessId $procId -Label "run-all.ps1" | Out-Null
  }
}

Start-Sleep -Milliseconds 500

Write-Step "端口检查..."
if (Test-PortInUse -Port $BridgePort) {
  Write-Host "  警告: 端口 $BridgePort 仍被占用，可能有非本项目进程或需稍后再试。"
} else {
  Write-Host "  端口 $BridgePort 已释放。"
}

if (-not $SkipWeb) {
  if (Test-PortInUse -Port $WebPort) {
    Write-Host "  端口 $WebPort 仍被占用（可能不是本项目 Vite）。"
  } else {
    Write-Host "  端口 $WebPort 已释放。"
  }
}

Write-Host ""
Write-Host "停止完成。重新启动请运行 run.bat"
Write-Host ""
exit 0


