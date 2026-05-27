# 在隐藏窗口中启动 run-all.ps1，轮询日志直到启动完成或失败，然后退出（不阻塞控制台）
param(
  [switch]$NoWeb,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Remaining
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$RunAllScript = Join-Path $PSScriptRoot "run-all.ps1"
$LogPath = Join-Path $env:TEMP "chattingcursor-run-all.log"
$runAllArgs = @()
if (-not $NoWeb) {
  $runAllArgs += "-WithWeb"
}
if ($Remaining) {
  $runAllArgs += $Remaining
}
if (Test-Path $LogPath) {
  Remove-Item $LogPath -Force -ErrorAction SilentlyContinue
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
  -RedirectStandardError $LogPath `
  -PassThru
Write-Host "Starting ChattingCursor in background (monitor PID $($proc.Id))..."
Write-Host "Log: $LogPath"
$deadline = (Get-Date).AddSeconds(150)
$startupOk = $false
$startupFail = $false
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
    if ($tail -match '\[FAIL\]' -and $tail -notmatch 'Public health not confirmed yet') {
      $startupFail = $true
      break
    }
  }
  Start-Sleep -Milliseconds 500
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
  exit 2
}
if ($startupFail -or ($proc.HasExited -and $proc.ExitCode -ne 0)) {
  $code = if ($proc.HasExited) { $proc.ExitCode } else { 1 }
  Write-Host "[FAIL] Startup did not finish successfully (exit $code). See log: $LogPath"
  exit $code
}
Write-Host "[OK] Background launcher is still starting (PID $($proc.Id))."
Write-Host "     Watch the log for ""Startup flow complete"": $LogPath"
Write-Host "     Stop: shutdown.bat"
exit 0
