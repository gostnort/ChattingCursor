# One-click startup: Bridge + cloudflared quick tunnel, auto-updates publicBridgeUrl in token file
param(
  [int]$BridgePort = 4321,
  [int]$WebPort = 43210,
  [string]$TokenSyncDir = "",
  [switch]$WithWeb,
  [switch]$NoWeb,
  [switch]$WithQualityWatch,
  [switch]$VerboseTunnel
)

# Web dev server is on by default; use -NoWeb to skip (e.g. tunnel-only runs).
if ($NoWeb) {
  $WithWeb = $false
} elseif (-not $PSBoundParameters.ContainsKey('WithWeb')) {
  $WithWeb = $true
}

$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "Resolve-TokenSyncDir.ps1")
. (Join-Path $PSScriptRoot "Resolve-CloudflareTunnel.ps1")
. (Join-Path $PSScriptRoot "TokenFilePids.ps1")
. (Join-Path $PSScriptRoot "Get-TokenFileName.ps1")
$script:NamedTunnelConfig = Read-NamedCloudflareTunnelConfig
$TokenSyncDir = Resolve-TokenSyncDir -Override $TokenSyncDir
$script:ServicePids = @{}
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch {
  # 闈炰氦浜掔幆澧冨彲鑳芥棤娉曡缃帶鍒跺彴缂栫爜
}
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
. (Join-Path $PSScriptRoot "Resolve-CursorCliMode.ps1")
Initialize-CursorCliMode

$script:BridgeProcess = $null
$script:BridgeOwned = $false
$script:WebProcess = $null
$script:WebOwned = $false
$script:QualityWatchProcess = $null
$script:QualityWatchOwned = $false
$script:TunnelProcess = $null
$script:TunnelLogPath = Join-Path $env:TEMP "chattingcursor-cloudflared.log"
$script:BridgeLogPath = Join-Path $env:TEMP "chattingcursor-bridge.log"
$script:BridgeErrLogPath = Join-Path $env:TEMP "chattingcursor-bridge.err.log"
$script:TunnelUrlApplied = $false
$script:DetectedTunnelUrl = $null
$script:ShuttingDown = $false
$script:TunnelLogOffset = 0
# 姣?5 鍒嗛挓瀵瑰叕缃戦毀閬撳仛涓€娆?/health 鎺㈡祴锛涗换涓€娆″け璐ュ嵆浠呴噸鍚毀閬?
$script:HealthCheckIntervalSeconds = 300
$script:HealthCheckTimeoutSeconds = 15
$script:SecondsSinceHealthCheck = 0
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
    Write-Step "First run detected, installing dependencies..."
    & "$PSScriptRoot\install-all.ps1" -SkipCloudflared
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  }
  if (-not (Test-Path "$Root\packages\shared\dist")) {
    Write-Step "Building shared package..."
    pnpm --filter @chatting-cursor/shared build
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  }
  if (-not (Test-Path "$Root\packages\cli-client\dist")) {
    Write-Step "Building cli-client (Bridge dependency)..."
    pnpm --filter @chatting-cursor/cli-client build
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  }
  if (-not (Test-Path "$Root\packages\orchestrator\dist")) {
    Write-Step "Building orchestrator (Bridge dependency)..."
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


function Start-WebProcess {
  $pnpmExe = Resolve-PnpmExe
  $script:WebProcess = Start-Process -FilePath $pnpmExe -ArgumentList "dev:web" -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  $script:WebOwned = $true
  Set-ServicePid -Key "web" -ProcessId $script:WebProcess.Id
  Write-Host "Web process PID: $($script:WebProcess.Id) (pnpm: $pnpmExe)"
}


function Start-QualityWatchProcess {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  $nodeExe = if ($nodeCmd) { $nodeCmd.Source } else { $null }
  if (-not $nodeExe) {
    Write-Fail "node not found; cannot start quality watcher."
    return $false
  }
  $watchScript = Join-Path $Root "scripts\quality-watch.mjs"
  if (-not (Test-Path $watchScript)) {
    Write-Fail "quality-watch script not found: $watchScript"
    return $false
  }
  $logPath = Join-Path $env:TEMP "chattingcursor-quality-watch.log"
  if (Test-Path $logPath) {
    Remove-Item $logPath -Force -ErrorAction SilentlyContinue
  }
  $script:QualityWatchProcess = Start-Process -FilePath $nodeExe `
    -ArgumentList @($watchScript) `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $logPath `
    -RedirectStandardError $logPath `
    -WindowStyle Hidden `
    -PassThru
  $script:QualityWatchOwned = $true
  Set-ServicePid -Key "quality-watch" -ProcessId $script:QualityWatchProcess.Id
  Write-Ok "Quality watcher started (PID $($script:QualityWatchProcess.Id), log: $logPath)"
  return $true
}


function Get-LocalWebUrl {
  return "http://127.0.0.1:$WebPort/ChattingCursor/"
}


function Test-WebHealthy {
  $url = Get-LocalWebUrl
  try {
    $resp = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    return $resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500
  } catch {
    return $false
  }
}


function Wait-WebReady {
  param([int]$MaxSeconds = 90)
  $url = Get-LocalWebUrl
  for ($i = 0; $i -lt $MaxSeconds; $i++) {
    if (Test-WebHealthy) {
      return $true
    }
    if ($script:WebOwned -and $script:WebProcess -and $script:WebProcess.HasExited) {
      Write-Fail "Web startup process exited, code: $($script:WebProcess.ExitCode)"
      return $false
    }
    if ($i -gt 0 -and ($i % 15) -eq 0) {
      Write-Host "Still waiting for Web at $url (${i}s / ${MaxSeconds}s)..."
    }
    Start-Sleep -Seconds 1
  }
  if ($script:WebOwned -and $script:WebProcess -and $script:WebProcess.HasExited) {
    Write-Fail "Web startup process exited, code: $($script:WebProcess.ExitCode)"
  } else {
    Write-Fail "Web did not pass HTTP check within ${MaxSeconds}s: $url"
  }
  return $false
}


function Ensure-WebRunning {
  $url = Get-LocalWebUrl
  if (Test-WebHealthy) {
    if (Test-PortInUse -Port $WebPort) {
      Write-Ok "A healthy Web server is already running on port $WebPort; reusing existing instance."
    } else {
      Write-Ok "Local chat page is reachable: $url"
    }
    return $true
  }
  if (Test-PortInUse -Port $WebPort) {
    $stalePids = @(Get-ListenerPids -Port $WebPort)
    Write-Fail "Port $WebPort is in use but $url is not healthy (PID: $($stalePids -join ', '))"
    Write-Host "Run shutdown.bat first, or end those processes manually, then run run.bat again."
    return $false
  }
  Write-Step "Starting Web (port $WebPort)..."
  Start-WebProcess
  if (-not (Wait-WebReady)) {
    return $false
  }
  Write-Ok "Web is reachable locally: $url"
  return $true
}


function Show-LocalWebHint {
  $url = Get-LocalWebUrl
  Write-Host ""
  if (Test-WebHealthy) {
    Write-Host "Local chat page is reachable: $url"
  } elseif ($WithWeb) {
    Write-Host "Local chat page is not reachable: $url"
    if ($script:WebOwned) {
      Write-Host "Web was started by this run but is no longer responding."
    }
  } else {
    Write-Host "Local chat page was not started (run without -NoWeb to auto-start Web)."
    Write-Host "URL when running separately: $url"
  }
  Write-Host ""
}


function Stop-ChildProcesses {
  if ($script:QualityWatchOwned -and $script:QualityWatchProcess -and -not $script:QualityWatchProcess.HasExited) {
    try {
      & taskkill /PID $script:QualityWatchProcess.Id /T /F *>$null
    } catch {
      # 璐ㄩ噺瀹堟姢杩涚▼鍙兘宸查€€鍑?
    }
    $script:QualityWatchProcess = $null
  }
  if ($script:WebOwned -and $script:WebProcess -and -not $script:WebProcess.HasExited) {
    try {
      & taskkill /PID $script:WebProcess.Id /T /F *>$null
    } catch {
      # Web 杩涚▼鍙兘宸查€€鍑?
    }
    $script:WebProcess = $null
  }
  if ($script:TunnelProcess -and -not $script:TunnelProcess.HasExited) {
    try {
      & taskkill /PID $script:TunnelProcess.Id /T /F *>$null
    } catch {
      # 闅ч亾杩涚▼鍙兘宸查€€鍑?
    }
    $script:TunnelProcess = $null
  }
  if ($script:BridgeOwned -and $script:BridgeProcess -and -not $script:BridgeProcess.HasExited) {
    try {
      & taskkill /PID $script:BridgeProcess.Id /T /F *>$null
    } catch {
      # Bridge 杩涚▼鍙兘宸查€€鍑?
    }
    $script:BridgeProcess = $null
  }
}


function Ensure-HttpsPublicBridgeUrl([string]$Url) {
  $normalized = $Url.Trim().TrimEnd("/")
  if ($normalized -match '^https?://') {
    if ($normalized -match '^http://[a-z0-9-]+\.trycloudflare\.com') {
      return $normalized -replace '^http://', 'https://'
    }
    return $normalized
  }
  if ($normalized -match '^[a-z0-9-]+\.trycloudflare\.com$') {
    return "https://$normalized"
  }
  return $normalized
}


function Get-TokenFilePath {
  return Get-ChattingCursorTokenFilePath -TokenSyncDir $TokenSyncDir
}


function Initialize-FreshStartupPidTracking {
  $script:ServicePids = @{ "run-all" = $PID }
  Clear-TokenFilePidSection -FilePath (Get-TokenFilePath)
  Sync-ServicePidsToTokenFile
}


function Set-ServicePid {
  param(
    [string]$Key,
    [int]$ProcessId
  )
  if ($ProcessId -le 0) {
    return
  }
  $script:ServicePids[$Key] = $ProcessId
  Sync-ServicePidsToTokenFile
}


function Sync-ServicePidsToTokenFile {
  param([switch]$CloudflaredOnly)
  Merge-TokenFilePidSection -FilePath (Get-TokenFilePath) -PidMap $script:ServicePids -CloudflaredOnly:$CloudflaredOnly
}


function Restore-ServicePidsAfterBridgeTokenWrite {
  Sync-ServicePidsToTokenFile
}


function Get-TokenFilePathResolved {
  $path = Get-TokenFilePath
  if (Test-Path $path) {
    return (Resolve-Path -LiteralPath $path).Path
  }
  return [System.IO.Path]::GetFullPath($path)
}


function Show-TokenFileOpenReminder {
  param([string]$PublicUrl)
  $resolved = Get-TokenFilePathResolved
  Write-Host ""
  Write-Host "----------------------------------------"
  Write-Host "Token file full path:"
  Write-Host "  $resolved"
  Write-Host "publicBridgeUrl line:"
  Write-Host "  publicBridgeUrl: $PublicUrl"
  Write-Host ""
  Write-Host "Open this file in Notepad or VS Code; if already open, reload/reopen to see latest content."
  Write-Host "----------------------------------------"
  Write-Host ""
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


function Test-TokenFileHasExpectedPublicUrl {
  param([string]$FilePath = (Get-TokenFilePath))
  $onDisk = Get-TokenFilePublicUrl -FilePath $FilePath
  if (-not $onDisk) {
    return $false
  }
  if ($script:NamedTunnelConfig) {
    return $onDisk -eq $script:NamedTunnelConfig.PublicBridgeUrl
  }
  return (Test-TokenFileHasTrycloudflareUrl -FilePath $FilePath)
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


function Get-RecoveryTimestamp {
  return (Get-Date).ToUniversalTime().ToString('o')
}


function Invoke-BridgeRegenerateToken {
  $maxAttempts = 6
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
      $response = Invoke-RestMethod `
        -Uri "http://127.0.0.1:$BridgePort/local/regenerate-token" `
        -Method Post `
        -ContentType "application/json; charset=utf-8" `
        -ErrorAction Stop
      Write-Ok "Bridge regenerated today's token (date: $($response.tokenDate))"
      if ($response.tokenFilePath) {
        Write-Host "     Token file: $($response.tokenFilePath)"
      }
      Restore-ServicePidsAfterBridgeTokenWrite
      return $true
    } catch {
      if ($attempt -lt $maxAttempts) {
        Write-Host "Bridge regenerate-token attempt $attempt failed, retrying in 3s..."
        Start-Sleep -Seconds 3
        continue
      }
      Write-Fail "Bridge failed to regenerate token: $($_.Exception.Message)"
      return $false
    }
  }
  return $false
}


function Restart-TunnelProcess {
  $oldPid = $null
  if ($script:TunnelProcess) {
    $oldPid = $script:TunnelProcess.Id
    if (-not $script:TunnelProcess.HasExited) {
      try {
        & taskkill /PID $oldPid /T /F *>$null
        Write-Host "Stopped old tunnel PID $oldPid"
      } catch {
        # 闅ч亾杩涚▼鍙兘宸查€€鍑?
      }
    } elseif ($oldPid) {
      Write-Host "Old tunnel PID $oldPid already exited"
    }
  }
  $script:TunnelProcess = $null
  $script:TunnelUrlApplied = $false
  $script:DetectedTunnelUrl = $null
  $script:TunnelLogOffset = 0
  Start-TunnelProcess
  Set-ServicePid -Key "cloudflared" -ProcessId $script:TunnelProcess.Id
  Write-Host "Started new cloudflared (PID $($script:TunnelProcess.Id))"
}


function Wait-ForTunnelUrl {
  param([int]$MaxSeconds = 90)
  if ($script:NamedTunnelConfig) {
    $script:DetectedTunnelUrl = $script:NamedTunnelConfig.PublicBridgeUrl
    if (-not $script:TunnelUrlApplied) {
      $null = Set-PublicBridgeUrlInTokenFile -PublicUrl $script:DetectedTunnelUrl
    }
    return [bool]$script:TunnelUrlApplied
  }
  for ($tick = 0; $tick -lt ($MaxSeconds * 2); $tick++) {
    if ($script:ShuttingDown) {
      return $false
    }
    Start-Sleep -Milliseconds 500
    Read-TunnelLogNewLines
    if ($script:DetectedTunnelUrl -and -not $script:TunnelUrlApplied) {
      $null = Set-PublicBridgeUrlInTokenFile -PublicUrl $script:DetectedTunnelUrl -Force
    }
    if ($script:TunnelUrlApplied) {
      return $true
    }
    if ($script:TunnelProcess -and $script:TunnelProcess.HasExited) {
      Read-TunnelLogNewLines
      return $false
    }
  }
  Read-TunnelLogNewLines
  return $false
}


function Test-PublicBridgeCommunication([string]$PublicUrl) {
  if (-not $PublicUrl) {
    return $false
  }
  $healthUrl = "$PublicUrl/health"
  try {
    $resp = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec $script:HealthCheckTimeoutSeconds -ErrorAction Stop
    return $resp.status -eq "ok"
  } catch {
    return $false
  }
}




function Wait-PublicBridgeCommunication {
  param(
    [string]$PublicUrl,
    [int]$MaxWaitSeconds = 90,
    [int]$IntervalSeconds = 5
  )
  if (-not $PublicUrl) {
    return $false
  }
  $deadline = (Get-Date).AddSeconds($MaxWaitSeconds)
  $attempt = 0
  while ((Get-Date) -lt $deadline) {
    if ($script:ShuttingDown) {
      return $false
    }
    $attempt++
    if (Test-PublicBridgeCommunication -PublicUrl $PublicUrl) {
      if ($attempt -gt 1) {
        Write-Ok "Public health check passed after $attempt attempt(s): $PublicUrl/health"
      }
      return $true
    }
    if ($attempt -eq 1) {
      Write-Host "Waiting for public Bridge health at $PublicUrl/health (up to ${MaxWaitSeconds}s)..."
    }
    Start-Sleep -Seconds $IntervalSeconds
  }
  return $false
}

function Invoke-TunnelRecovery([string]$Reason) {
  $timestamp = Get-RecoveryTimestamp
  Write-Host "[RECOVERY START] Tunnel-only restart — reason: $Reason"
  # 仅重启 cloudflared；token/URL 仅经 Bridge API 写入（见 Set-PublicBridgeUrlInTokenFile）
  Restart-TunnelProcess
  if (-not (Wait-ForTunnelUrl -MaxSeconds 90)) {
    Write-Fail "[$timestamp] No new URL detected within timeout after tunnel restart"
    return $false
  }
  if (-not (Invoke-BridgeRegenerateToken)) {
    Write-Fail "[$timestamp] Bridge failed to rotate token after tunnel URL was applied"
    return $false
  }
  $onDisk = Get-TokenFilePublicUrl
  if (-not $onDisk) {
    Write-Fail "[$timestamp] Tunnel restarted but token file has no public URL"
    return $false
  }
  if (-not (Test-PublicBridgeHealth -PublicUrl $onDisk)) {
    Write-Fail "[$timestamp] [RECOVERY FAILED] New URL not reachable: $onDisk/health"
    return $false
  }
  Write-Host "[RECOVERY COMPLETE] New URL: $onDisk"
  Write-Ok "[$timestamp] Tunnel-only recovery finished (Bridge/Web unchanged)"
  return $true
}


function Set-PublicBridgeUrlInTokenFile([string]$PublicUrl, [switch]$Force) {
  if ($script:TunnelUrlApplied -and -not $Force) {
    return $true
  }
  $normalized = Ensure-HttpsPublicBridgeUrl $PublicUrl
  $body = @{ publicBridgeUrl = $normalized } | ConvertTo-Json
  try {
    $response = Invoke-RestMethod `
      -Uri "http://127.0.0.1:$BridgePort/local/public-bridge-url" `
      -Method Post `
      -ContentType "application/json; charset=utf-8" `
      -Body $body `
      -ErrorAction Stop
    Write-Ok "Bridge rotated token and set publicBridgeUrl: $($response.publicBridgeUrl)"
    if ($response.tokenFilePath) {
      Write-Host "     Bridge token file: $($response.tokenFilePath)"
    }
  } catch {
    Write-Fail "Bridge API failed to rotate token and set URL: $($_.Exception.Message)"
    return $false
  }
  if (-not (Test-TokenFileHasExpectedPublicUrl)) {
    if ($script:NamedTunnelConfig) {
      Write-Fail "Token file publicBridgeUrl does not match named tunnel hostname"
    } else {
      Write-Fail "No trycloudflare public URL found in token file"
    }
    return $false
  }
  $onDisk = Get-TokenFilePublicUrl
  if ($onDisk -ne $normalized) {
    Write-Fail "Token file URL does not match tunnel URL: $onDisk"
    return $false
  }
  Write-Ok "Token file now contains public URL: $onDisk"
  Restore-ServicePidsAfterBridgeTokenWrite
  $script:TunnelUrlApplied = $true
  Show-TokenFileOpenReminder -PublicUrl $onDisk
  Write-Host "Phone setup path: GitHub Pages -> Local -> Config"
  Write-Host "  Bridge URL = $onDisk"
  Write-Host "  Today's token = copy from token file"
  Write-Host ""
  return $true
}


function Test-PublicBridgeHealth([string]$PublicUrl) {
  $healthUrl = "$PublicUrl/health"
  for ($attempt = 1; $attempt -le 6; $attempt++) {
    try {
      $resp = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 15 -ErrorAction Stop
      if ($resp.status -eq "ok") {
      Write-Ok "Public health check passed: $healthUrl"
        return $true
      }
      Write-Fail "Public health check returned unexpected response: $healthUrl"
      return $false
    } catch {
      if ($attempt -lt 6) {
        Write-Host "Public health check attempt ${attempt} failed, retrying in 5s..."
        Start-Sleep -Seconds 5
      } else {
        Write-Fail "Public health check failed (tunnel URL already written to token file): $($_.Exception.Message)"
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
  Write-Ok "Detected cloudflared tunnel URL: $url"
  $null = Set-PublicBridgeUrlInTokenFile -PublicUrl $url
}


function Write-TunnelLine([string]$Line) {
  if ([string]::IsNullOrWhiteSpace($Line)) {
    return
  }
  if ($VerboseTunnel) {
    Write-Host ('[tunnel] ' + $Line)
  }
  Invoke-TunnelLine -Line $Line
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
          Write-TunnelLine -Line $line
        }
      }
    }
  } catch {
    # 娴佸彲鑳芥殏鏃朵笉鍙
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
          Write-TunnelLine -Line $line
        }
      }
      $script:TunnelLogOffset = $stream.Position
    } finally {
      $stream.Dispose()
    }
  } catch {
    # 鏃ュ織鍙兘姝ｈ cloudflared 鍐欏叆锛屼笅涓€杞啀璇?
  }
}


function Show-BridgeStartupLog {
  if (-not $script:BridgeLogPath -or -not (Test-Path $script:BridgeLogPath)) {
    return
  }
  Write-Host ""
  Write-Host "Bridge startup log (last 40 lines): $($script:BridgeLogPath)"
  try {
    Get-Content -LiteralPath $script:BridgeLogPath -Tail 40 -ErrorAction Stop | ForEach-Object { Write-Host $_ }
  } catch {
    Write-Host "(could not read bridge log)"
  }
  Write-Host ""
}


function Wait-BridgeReady {
  param([int]$MaxSeconds = 120)
  $healthUrl = "http://127.0.0.1:$BridgePort/health"
  Write-Host "Waiting for Bridge /health at $healthUrl (max ${MaxSeconds}s)..."
  for ($i = 0; $i -lt $MaxSeconds; $i++) {
    if ($script:BridgeOwned -and $script:BridgeProcess -and $script:BridgeProcess.HasExited) {
      Write-Fail "Bridge startup process exited, code: $($script:BridgeProcess.ExitCode)"
      Show-BridgeStartupLog
      return $false
    }
    try {
      $null = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2 -ErrorAction Stop
      return $true
    } catch {
      if ($i -gt 0 -and ($i % 15) -eq 0) {
        Write-Host "Still waiting for Bridge /health (${i}s / ${MaxSeconds}s)..."
      }
      Start-Sleep -Seconds 1
    }
  }
  if ($script:BridgeProcess -and $script:BridgeProcess.HasExited) {
    Write-Fail "Bridge startup process exited, code: $($script:BridgeProcess.ExitCode)"
  } else {
    Write-Fail "Bridge did not pass /health check within ${MaxSeconds}s"
  }
  Show-BridgeStartupLog
  return $false
}


function Get-ListenerPids([int]$Port) {
  $pids = @()
  try {
    $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    # Get-NetTCPConnection 涓嶅彲鐢ㄦ椂鍥為€€ netstat
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
  Write-Host "Port $BridgePort is in use, attempting cleanup of stale processes..."
  Write-Host "(You can also run shutdown.bat first)"
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
  # Windows: pnpm.cmd dev; log file helps when build fails under Hidden window
  $env:CHATTINGCURSOR_TOKEN_SYNC_DIR = $TokenSyncDir
  $env:BRIDGE_PUBLIC_URL = "http://127.0.0.1:$BridgePort"
  $env:BRIDGE_PORT = "$BridgePort"
  $pnpmExe = Resolve-PnpmExe
  if (Test-Path $script:BridgeLogPath) {
    Remove-Item $script:BridgeLogPath -Force -ErrorAction SilentlyContinue
  }
  $script:BridgeProcess = Start-Process -FilePath $pnpmExe `
    -ArgumentList "dev:bridge" `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $script:BridgeLogPath `
    -RedirectStandardError $script:BridgeErrLogPath `
    -WindowStyle Hidden `
    -PassThru
  $script:BridgeOwned = $true
  Set-ServicePid -Key "bridge" -ProcessId $script:BridgeProcess.Id
  Write-Host "Bridge process PID: $($script:BridgeProcess.Id) (pnpm: $pnpmExe)"
  Write-Host "Bridge log: $($script:BridgeLogPath)"
}


function Start-TunnelProcess {
  $cloudflaredExe = Resolve-CloudflaredExe
  if (-not $cloudflaredExe) {
    throw "cloudflared executable not found"
  }
  if (Test-Path $script:TunnelLogPath) {
    Remove-Item $script:TunnelLogPath -Force -ErrorAction SilentlyContinue
  }
  $script:TunnelLogOffset = 0
  if ($script:NamedTunnelConfig) {
    $tunnelName = $script:NamedTunnelConfig.TunnelName
    Write-Host "cloudflared named tunnel: $tunnelName -> $($script:NamedTunnelConfig.PublicBridgeUrl)"
    $script:TunnelProcess = Start-Process -FilePath $cloudflaredExe `
      -ArgumentList @("tunnel", "run", $tunnelName) `
      -RedirectStandardError $script:TunnelLogPath `
      -WindowStyle Hidden `
      -PassThru
  } else {
    $script:TunnelProcess = Start-Process -FilePath $cloudflaredExe `
      -ArgumentList @("tunnel", "--url", "http://127.0.0.1:$BridgePort") `
      -RedirectStandardError $script:TunnelLogPath `
      -WindowStyle Hidden `
      -PassThru
  }
  Set-ServicePid -Key "cloudflared" -ProcessId $script:TunnelProcess.Id
  Write-Host "cloudflared: $cloudflaredExe (PID $($script:TunnelProcess.Id))"
  Write-Host "Tunnel log: $($script:TunnelLogPath)"
}


try {
  [Console]::TreatControlCAsInput = $false
  [Console]::CancelKeyPress.Add({
    param($sender, $e)
    $e.Cancel = $true
    $script:ShuttingDown = $true
    Write-Host ""
    Write-Host "Stopping Bridge and tunnel..."
    Stop-ChildProcesses
  }) | Out-Null
} catch {
  # 闈炰氦浜掔粓绔棤娉曟敞鍐?Ctrl+C
}

$exitCode = 0
try {
  Write-Host "=== ChattingCursor Remote Startup ==="
  Write-Host "Token sync directory: $TokenSyncDir"
  Write-Host "Token file full path: $(Get-TokenFilePathResolved)"
  Write-Host "Stop: press Ctrl+C"
  Write-Host ""

  Ensure-ProjectReady

  if (-not (Test-CloudflaredInstalled)) {
    Write-Fail "cloudflared not found. Run install.bat first."
    exit 1
  }
  Write-Ok "cloudflared found: $(Resolve-CloudflaredExe)"

  if (Test-PortInUse -Port $BridgePort) {
    if (Test-BridgeHealthy) {
      Write-Ok "A healthy Bridge is already running on port $BridgePort; reusing existing instance."
    } elseif (-not (Clear-StaleBridgePort)) {
      $stalePids = @(Get-ListenerPids -Port $BridgePort)
      Write-Fail "Port $BridgePort is still occupied (PID: $($stalePids -join ', '))"
      Write-Host "Run shutdown.bat first, or end those processes manually, then run run.bat again."
      exit 2
    } else {
      Write-Ok "Port $BridgePort has been released"
    }
  }

  Initialize-FreshStartupPidTracking

  if (-not (Test-BridgeHealthy)) {
    Write-Step "Starting Bridge (port $BridgePort)..."
    Start-BridgeProcess
    if (-not (Wait-BridgeReady)) {
      Write-Fail "Bridge did not become ready in time; run shutdown.bat and retry."
      exit 1
    }
  }
  Write-Ok "Bridge local health: http://127.0.0.1:$BridgePort/health"
  Restore-ServicePidsAfterBridgeTokenWrite

  if ($WithQualityWatch) {
    Write-Step "Starting quality watcher (typecheck/lint + crew dry-run)..."
    $null = Start-QualityWatchProcess
  }

  if ($WithWeb) {
    if (-not (Ensure-WebRunning)) {
      exit 1
    }
  }

  if ($script:NamedTunnelConfig) {
    Write-Step "Starting cloudflared named tunnel ($($script:NamedTunnelConfig.TunnelName))..."
  } else {
    Write-Step "Starting cloudflared quick tunnel..."
  }
  Start-TunnelProcess

  $tunnelWaitSeconds = 90
  $startupTunnelReady = $false
  $script:StartupPublicHealthWaitDone = $false
  $script:StartupTunnelRecoveryAttempted = $false
  if ($script:NamedTunnelConfig) {
    Write-Host "Applying stable public URL: $($script:NamedTunnelConfig.PublicBridgeUrl)"
  } else {
    Write-Host "Waiting for tunnel URL (max ${tunnelWaitSeconds}s)..."
  }
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
      $publicUrl = Get-TokenFilePublicUrl
      if ($publicUrl -and (Test-PublicBridgeCommunication -PublicUrl $publicUrl)) {
        Write-Ok "Public health check passed: $publicUrl/health"
        $startupTunnelReady = $true
        break
      }
      if (-not $script:StartupPublicHealthWaitDone) {
        $script:StartupPublicHealthWaitDone = $true
        if ($publicUrl -and (Wait-PublicBridgeCommunication -PublicUrl $publicUrl -MaxWaitSeconds 75 -IntervalSeconds 5)) {
          Write-Ok "Public health check passed: $publicUrl/health"
          $startupTunnelReady = $true
          break
        }
      }
      if (-not $script:StartupTunnelRecoveryAttempted) {
        $script:StartupTunnelRecoveryAttempted = $true
        $healthReason = if ($publicUrl) {
          "Startup health check failed: $publicUrl/health"
        } else {
          "Token file missing public URL after tunnel URL was applied"
        }
        Write-Fail "$healthReason; starting tunnel-only recovery (one attempt)..."
        $null = Invoke-TunnelRecovery -Reason $healthReason
        $afterUrl = Get-TokenFilePublicUrl
        if ($afterUrl -and (Wait-PublicBridgeCommunication -PublicUrl $afterUrl -MaxWaitSeconds 60 -IntervalSeconds 5)) {
          Write-Ok "Public health check passed after recovery: $afterUrl/health"
          $startupTunnelReady = $true
          break
        }
      }
      continue
    }
    if ($script:TunnelProcess -and $script:TunnelProcess.HasExited) {
      Read-TunnelLogNewLines
      if (-not (Invoke-TunnelRecovery -Reason "cloudflared exited, code: $($script:TunnelProcess.ExitCode)")) {
        break
      }
    }
    if ($script:BridgeOwned -and $script:BridgeProcess -and $script:BridgeProcess.HasExited -and -not (Test-BridgeHealthy)) {
      Write-Fail "Bridge process exited, code: $($script:BridgeProcess.ExitCode)"
      break
    }
  }

  if (-not $startupTunnelReady) {
    Read-TunnelLogNewLines
    if (-not $script:TunnelUrlApplied) {
      if ($script:NamedTunnelConfig) {
        Write-Fail "Named tunnel did not apply publicBridgeUrl within ${tunnelWaitSeconds}s. Check tunnel log: $($script:TunnelLogPath)"
      } else {
        Write-Fail "No trycloudflare URL detected within ${tunnelWaitSeconds}s. Check tunnel log: $($script:TunnelLogPath)"
      }
      exit 1
    }
    $failedUrl = Get-TokenFilePublicUrl
    Write-Fail "Public health not confirmed yet ($failedUrl/health). Entering monitor loop; will keep retrying."
  }

  Write-Ok "Startup flow complete. Services are running."
  Show-LocalWebHint
  Write-Host ""

  while (-not $script:ShuttingDown) {
    Start-Sleep -Milliseconds 500
    Read-TunnelLogNewLines
    if ($script:BridgeOwned -and $script:BridgeProcess -and $script:BridgeProcess.HasExited -and -not (Test-BridgeHealthy)) {
      Write-Fail "Bridge process exited, code: $($script:BridgeProcess.ExitCode)"
      $exitCode = 1
      break
    }
    if ($script:TunnelProcess -and $script:TunnelProcess.HasExited) {
      Read-TunnelLogNewLines
      if (-not (Invoke-TunnelRecovery -Reason "cloudflared exited, code: $($script:TunnelProcess.ExitCode)")) {
        Write-Fail "Tunnel recovery failed; will retry on next check."
      }
      $script:SecondsSinceHealthCheck = 0
      continue
    }
    $script:SecondsSinceHealthCheck += 0.5
    if ($script:SecondsSinceHealthCheck -ge $script:HealthCheckIntervalSeconds) {
      $script:SecondsSinceHealthCheck = 0
      $publicUrl = Get-TokenFilePublicUrl
      if ($publicUrl -and -not (Test-PublicBridgeCommunication -PublicUrl $publicUrl)) {
        $timestamp = Get-RecoveryTimestamp
        Write-Fail "[$timestamp] Public health check failed ($publicUrl/health); starting tunnel-only recovery now"
        if (-not (Invoke-TunnelRecovery -Reason "Public health check failed: $publicUrl/health")) {
          Write-Fail "Tunnel recovery failed; will retry on next health check interval."
        }
      }
    }
  }
}
finally {
  Stop-ChildProcesses
}
exit $exitCode
