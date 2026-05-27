# Stop ChattingCursor background services (Bridge, cloudflared, Web, quality-watch, run-all)
param(
  [int]$BridgePort = 4321,
  [int]$WebPort = 43210,
  [int]$PortWaitSeconds = 30,
  [switch]$SkipWeb
)

$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "Resolve-TokenSyncDir.ps1")
. (Join-Path $PSScriptRoot "TokenFilePids.ps1")
$TokenSyncDir = Resolve-TokenSyncDir -Override ""
$TokenFilePath = Join-Path $TokenSyncDir "chattingcursor-token.txt"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RootPattern = [regex]::Escape($Root)
$StoppedBridge = $false
$StoppedCloudflared = $false
$StoppedWeb = $false
$StoppedQualityWatch = $false


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


function Get-ProcessCommandLine([int]$ProcessId) {
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    return $proc.CommandLine
  } catch {
    return $null
  }
}


function Get-ProcessShortName([int]$ProcessId) {
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($proc) {
    return $proc.ProcessName
  }
  return "unknown"
}


function Get-ListenerPids([int]$Port) {
  $pids = @()
  try {
    $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    # Fall back to netstat when Get-NetTCPConnection is unavailable
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
    $CommandLine -match 'dev:bridge|@chatting-cursor/bridge|apps\\bridge|tsx(\s+watch)?\s+src\\index\.ts|apps/bridge.*src/index\.ts'
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


function Test-QualityWatchCommandLine([string]$CommandLine) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return $false
  }
  if ($CommandLine -notmatch $RootPattern) {
    return $false
  }
  return ($CommandLine -match 'quality-watch\.mjs|quality:watch')
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
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $proc) {
    return $false
  }
  # Prefer killing the full process tree so node children do not keep ports open
  & taskkill /PID $ProcessId /T /F *>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  Stopped $Label (PID $ProcessId, including child processes)"
    return $true
  }
  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    Write-Host "  Stopped $Label (PID $ProcessId)"
    return $true
  } catch {
    Write-Host "  Could not stop $Label (PID $ProcessId): $($_.Exception.Message)"
    return $false
  }
}


function Test-ProjectPortListener([string]$CommandLine, [int]$ProcessId) {
  if (Test-BridgeCommandLine -CommandLine $CommandLine) {
    return $true
  }
  if (Test-WebCommandLine -CommandLine $CommandLine) {
    return $true
  }
  if (Test-QualityWatchCommandLine -CommandLine $CommandLine) {
    return $true
  }
  if ($CommandLine -and ($CommandLine -match $RootPattern)) {
    return $true
  }
  try {
    $currentId = $ProcessId
    for ($depth = 0; $depth -lt 5; $depth++) {
      $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $currentId" -ErrorAction SilentlyContinue
      if (-not $parent) {
        break
      }
      $parentCmd = $parent.CommandLine
      if ($parentCmd -and ($parentCmd -match $RootPattern)) {
        return $true
      }
      if (-not $parent.ParentProcessId -or $parent.ParentProcessId -le 4) {
        break
      }
      $currentId = [int]$parent.ParentProcessId
    }
  } catch {
    return $false
  }
  return $false
}


function Clear-PortListeners([int]$Port, [int]$MaxWaitSeconds) {
  $deadline = (Get-Date).AddSeconds($MaxWaitSeconds)
  while ((Get-Date) -lt $deadline) {
    $pids = @(Get-ListenerPids -Port $Port)
    if ($pids.Count -eq 0) {
      return $true
    }
    foreach ($procId in $pids) {
      $cmd = Get-ProcessCommandLine -ProcessId $procId
      if (Test-ProjectPortListener -CommandLine $cmd -ProcessId $procId) {
        Stop-ProcessSafe -ProcessId $procId -Label "listener on port $Port" | Out-Null
      }
    }
    Start-Sleep -Milliseconds 500
  }
  return -not (Test-PortInUse -Port $Port)
}


function Format-PortHolderReport([int]$Port) {
  $pids = @(Get-ListenerPids -Port $Port)
  if ($pids.Count -eq 0) {
    return $null
  }
  $details = @()
  foreach ($procId in $pids) {
    $name = Get-ProcessShortName -ProcessId $procId
    $cmd = Get-ProcessCommandLine -ProcessId $procId
    if ([string]::IsNullOrWhiteSpace($cmd)) {
      $details += "PID $procId ($name)"
    } else {
      $shortCmd = if ($cmd.Length -gt 120) { $cmd.Substring(0, 117) + "..." } else { $cmd }
      $details += "PID $procId ($name): $shortCmd"
    }
  }
  return ($details -join "; ")
}


function Get-RemainingCloudflaredPids() {
  $remaining = @()
  foreach ($proc in (Get-AllCandidateProcesses)) {
    $procId = [int]$proc.ProcessId
    if ($procId -le 4) {
      continue
    }
    if (($proc.Name -match 'cloudflared') -and (Test-CloudflaredCommandLine -CommandLine $proc.CommandLine)) {
      $remaining += $procId
    }
  }
  return @($remaining | Select-Object -Unique)
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


Write-Host "=== ChattingCursor shutdown ==="
Write-Host "Project root: $Root"
Write-Host "Token file: $TokenFilePath"
Write-Host "Port wait timeout: ${PortWaitSeconds}s"
Write-Host ""

$tokenPidMap = Get-TokenFilePidMap -FilePath $TokenFilePath
if ($tokenPidMap.Count -gt 0) {
  Write-Step "Stopping processes from token file (pid.*)..."
  foreach ($key in $script:ManagedPidKeyOrder) {
    if (-not $tokenPidMap.ContainsKey($key)) {
      continue
    }
    $procId = [int]$tokenPidMap[$key]
    if ($procId -le 4) {
      continue
    }
    $label = "pid.$key"
    if (Stop-ProcessSafe -ProcessId $procId -Label $label) {
      switch ($key) {
        "bridge" { $StoppedBridge = $true }
        "cloudflared" { $StoppedCloudflared = $true }
        "web" { $StoppedWeb = $true }
        "quality-watch" { $StoppedQualityWatch = $true }
        default { }
      }
    }
  }
  Start-Sleep -Milliseconds 500
}

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
  if (Test-QualityWatchCommandLine -CommandLine $cmd) {
    $candidatePids[$procId] = "quality-watch"
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

Write-Step "Stopping Bridge (port $BridgePort)..."
$bridgePids = @($candidatePids.GetEnumerator() | Where-Object { $_.Value -eq "Bridge" } | ForEach-Object { $_.Key })
if ($bridgePids.Count -eq 0) {
  Write-Host "  No Bridge process found."
} else {
  foreach ($procId in ($bridgePids | Sort-Object -Descending)) {
    if (Stop-ProcessSafe -ProcessId $procId -Label "Bridge") {
      $StoppedBridge = $true
    }
  }
  if ($StoppedBridge) {
    Write-Host "Bridge stopped."
  }
}

Write-Step "Stopping cloudflared tunnel..."
$cloudPids = @($candidatePids.GetEnumerator() | Where-Object { $_.Value -eq "cloudflared" } | ForEach-Object { $_.Key })
if ($cloudPids.Count -eq 0) {
  Write-Host "  No cloudflared tunnel process found."
} else {
  foreach ($procId in ($cloudPids | Sort-Object -Descending)) {
    if (Stop-ProcessSafe -ProcessId $procId -Label "cloudflared") {
      $StoppedCloudflared = $true
    }
  }
  if ($StoppedCloudflared) {
    Write-Host "cloudflared stopped."
  }
}

Write-Step "Stopping quality-watch..."
$watchPids = @($candidatePids.GetEnumerator() | Where-Object { $_.Value -eq "quality-watch" } | ForEach-Object { $_.Key })
if ($watchPids.Count -eq 0) {
  Write-Host "  No quality-watch process found."
} else {
  foreach ($procId in ($watchPids | Sort-Object -Descending)) {
    if (Stop-ProcessSafe -ProcessId $procId -Label "quality-watch") {
      $StoppedQualityWatch = $true
    }
  }
  if ($StoppedQualityWatch) {
    Write-Host "quality-watch stopped."
  }
}

if (-not $SkipWeb) {
  Write-Step "Stopping Web / Vite (port $WebPort)..."
  $webPids = @($candidatePids.GetEnumerator() | Where-Object { $_.Value -eq "Web" } | ForEach-Object { $_.Key })
  if ($webPids.Count -eq 0) {
    Write-Host "  No Web dev server found."
  } else {
    foreach ($procId in ($webPids | Sort-Object -Descending)) {
      if (Stop-ProcessSafe -ProcessId $procId -Label "Web") {
        $StoppedWeb = $true
      }
    }
    if ($StoppedWeb) {
      Write-Host "Web (Vite) stopped."
    }
  }
}

$runAllPids = @($candidatePids.GetEnumerator() | Where-Object { $_.Value -eq "run-all" } | ForEach-Object { $_.Key })
if ($runAllPids.Count -gt 0) {
  Write-Step "Stopping run-all launcher..."
  foreach ($procId in ($runAllPids | Sort-Object -Descending)) {
    Stop-ProcessSafe -ProcessId $procId -Label "run-all.ps1" | Out-Null
  }
}

Write-Step "Releasing ports (retry up to ${PortWaitSeconds}s)..."
$portsToVerify = @(@{ Port = $BridgePort; Label = "Bridge" })
if (-not $SkipWeb) {
  $portsToVerify += @{ Port = $WebPort; Label = "Web" }
}

foreach ($entry in $portsToVerify) {
  $port = [int]$entry.Port
  $label = [string]$entry.Label
  if (Test-PortInUse -Port $port) {
    Write-Host "  Port $port ($label) still in use; retrying project listener cleanup..."
  }
  $released = Clear-PortListeners -Port $port -MaxWaitSeconds $PortWaitSeconds
  if ($released) {
    Write-Ok "Port $port ($label) is free."
  } else {
    $report = Format-PortHolderReport -Port $port
    Write-Fail "Port $port ($label) still in use after ${PortWaitSeconds}s: $report"
  }
}

Write-Step "Verifying cloudflared..."
$remainingCloud = @(Get-RemainingCloudflaredPids)
if ($remainingCloud.Count -eq 0) {
  Write-Ok "No project cloudflared tunnel process running."
} else {
  foreach ($procId in $remainingCloud) {
    Stop-ProcessSafe -ProcessId $procId -Label "cloudflared (retry)" | Out-Null
  }
  Start-Sleep -Seconds 1
  $remainingCloud = @(Get-RemainingCloudflaredPids)
  if ($remainingCloud.Count -eq 0) {
    Write-Ok "cloudflared stopped after retry."
  } else {
    Write-Fail "cloudflared still running (PID: $($remainingCloud -join ', '))."
  }
}

$shutdownFailed = $false
foreach ($entry in $portsToVerify) {
  $port = [int]$entry.Port
  $label = [string]$entry.Label
  if (Test-PortInUse -Port $port) {
    $shutdownFailed = $true
  }
}

if ((Get-RemainingCloudflaredPids).Count -gt 0) {
  $shutdownFailed = $true
}

Write-Host ""
if ($shutdownFailed) {
  Write-Fail "Shutdown incomplete. Free the ports/processes above, then run run.bat again."
  exit 1
}

Write-Ok "All checked ports and cloudflared are stopped."
Clear-TokenFilePidSection -FilePath $TokenFilePath
Write-Host ""
Write-Host "Shutdown complete. Start again with run.bat"
Write-Host ""
exit 0
