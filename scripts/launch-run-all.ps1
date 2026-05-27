param(
  [switch]$NoWeb,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Remaining
)

# 后台启动并监控 run-all.ps1，轮询日志直到启动完成或失败，然后退出（不占用控制台窗口）
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "Resolve-CursorCliMode.ps1")
Initialize-CursorCliMode
$RunAllScript = Join-Path $PSScriptRoot "run-all.ps1"
$LogPath = Join-Path $env:TEMP "chattingcursor-run-all.log"
$ErrLogPath = Join-Path $env:TEMP "chattingcursor-run-all.err.log"
$runAllArgs = @()
if (-not $NoWeb) {
  $runAllArgs += "-WithWeb"
}
if ($Remaining) {
  $runAllArgs += $Remaining
}
foreach ($path in @($LogPath, $ErrLogPath)) {
  if (Test-Path $path) {
    Remove-Item $path -Force -ErrorAction SilentlyContinue
  }
}
function Test-LocalServicesHealthy {
  param(
    [int]$BridgePort = 4321,
    [int]$WebPort = 43210,
    [switch]$RequireWeb
  )
  try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$BridgePort/health" -Method Get -TimeoutSec 3 -ErrorAction Stop
  } catch {
    return $false
  }
  if (-not $RequireWeb) {
    return $true
  }
  $webUrl = "http://127.0.0.1:$WebPort/ChattingCursor/"
  try {
    $resp = Invoke-WebRequest -Uri $webUrl -Method Get -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500)
  } catch {
    return $false
  }
}
$argList = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", $RunAllScript
) + $runAllArgs
$proc = Start-Process -FilePath "powershell.exe" `
  -ArgumentList $argList `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $LogPath `
  -RedirectStandardError $ErrLogPath `
  -PassThru
Write-Host "Starting ChattingCursor in background (monitor PID $($proc.Id))..."
Write-Host "Log: $LogPath"
Write-Host "Err: $ErrLogPath"
$deadline = (Get-Date).AddSeconds(150)
$startupOk = $false
$startupFail = $false
$requireWeb = -not $NoWeb
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) {
    break
  }
  if (Test-Path $LogPath) {
    $tail = Get-Content -LiteralPath $LogPath -Tail 80 -ErrorAction SilentlyContinue
    if ($tail -match '\[FAIL\].*Port 4321 is still occupied|exit 2') {
      $startupFail = $true
      break
    }
    if ($tail -match 'Startup flow complete') {
      $startupOk = $true
      break
    }
  }
  Start-Sleep -Milliseconds 500
}
if (-not $startupOk) {
  if (Test-LocalServicesHealthy -RequireWeb:$requireWeb) {
    $startupOk = $true
  }
}
function Write-RunAllErrTail {
  if (-not (Test-Path $ErrLogPath)) {
    return
  }
  $errTail = Get-Content -LiteralPath $ErrLogPath -Tail 40 -ErrorAction SilentlyContinue
  if (-not $errTail) {
    return
  }
  Write-Host ""
  Write-Host "--- stderr (last 40 lines): $ErrLogPath ---"
  $errTail | ForEach-Object { Write-Host $_ }
}
Write-Host ""
if ($startupOk) {
  Write-Host "[OK] Startup flow complete. Services keep running in the background."
  Write-Host "     Check pid.* lines in your token file (chattingcursor-token.txt)."
  Write-Host "     Stop everything: shutdown.bat"
  Write-Host "     Monitor log: $LogPath"
  exit 0
}
if ($proc.HasExited -and $proc.ExitCode -eq 2) {
  Write-Host "[FAIL] Port conflict or cleanup failed (exit 2). See log: $LogPath"
  Write-RunAllErrTail
  exit 2
}
if ($startupFail) {
  Write-Host "[FAIL] Startup did not finish successfully. See log: $LogPath"
  Write-RunAllErrTail
  exit 2
}
if ($proc.HasExited -and $proc.ExitCode -ne 0) {
  Write-Host "[FAIL] Startup did not finish successfully (exit $($proc.ExitCode)). See log: $LogPath"
  Write-RunAllErrTail
  exit $proc.ExitCode
}
Write-Host "[OK] Background launcher is still starting (PID $($proc.Id))."
Write-Host "     Watch the log for ""Startup flow complete"": $LogPath"
Write-Host "     Stop: shutdown.bat"
exit 0
