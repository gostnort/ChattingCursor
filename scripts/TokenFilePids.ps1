# 共享：token 文件中的 pid.* 段（由 run-all 写入，shutdown 读取）
$script:TokenPidHeader = "# processes (managed by run-all)"
$script:ManagedPidKeyOrder = @("bridge", "web", "cloudflared", "quality-watch", "run-all")


function Test-IsTokenPidLine([string]$Line) {
  if ([string]::IsNullOrWhiteSpace($Line)) {
    return $false
  }
  $trimmed = $Line.Trim()
  if ($trimmed -eq $script:TokenPidHeader) {
    return $true
  }
  return $trimmed -match "^\s*pid\.[a-z0-9-]+\s*="
}


function Get-TokenFilePidMap {
  param([string]$FilePath)
  $map = @{}
  if (-not $FilePath -or -not (Test-Path -LiteralPath $FilePath)) {
    return $map
  }
  foreach ($line in (Get-Content -LiteralPath $FilePath -ErrorAction SilentlyContinue)) {
    if ($line -match "^\s*pid\.([a-z0-9-]+)\s*=\s*(\d+)\s*$") {
      $map[$Matches[1]] = [int]$Matches[2]
    }
  }
  return $map
}


function Remove-TokenPidLinesFromContentLines {
  param([string[]]$Lines)
  $filtered = @($Lines | Where-Object { -not (Test-IsTokenPidLine $_) })
  while ($filtered.Count -gt 0 -and [string]::IsNullOrWhiteSpace($filtered[-1])) {
    $filtered = $filtered[0..($filtered.Count - 2)]
  }
  return $filtered
}


function Format-TokenPidSectionLines {
  param([hashtable]$PidMap)
  if (-not $PidMap -or $PidMap.Count -eq 0) {
    return @()
  }
  $out = @($script:TokenPidHeader)
  foreach ($key in $script:ManagedPidKeyOrder) {
    if ($PidMap.ContainsKey($key) -and $PidMap[$key] -gt 0) {
      $out += "pid.$key=$($PidMap[$key])"
    }
  }
  return $out
}


function Merge-TokenFilePidSection {
  param(
    [string]$FilePath,
    [hashtable]$PidMap,
    [switch]$CloudflaredOnly
  )
  if (-not $FilePath) {
    return
  }
  $merged = @{}
  if ($CloudflaredOnly -and (Test-Path -LiteralPath $FilePath)) {
    $merged = Get-TokenFilePidMap -FilePath $FilePath
  }
  foreach ($entry in $PidMap.GetEnumerator()) {
    if ($CloudflaredOnly -and $entry.Key -ne "cloudflared") {
      continue
    }
    if ($entry.Value -gt 0) {
      $merged[$entry.Key] = [int]$entry.Value
    }
  }
  $authLines = @()
  if (Test-Path -LiteralPath $FilePath) {
    $authLines = @(Get-Content -LiteralPath $FilePath -ErrorAction SilentlyContinue)
    $authLines = @(Remove-TokenPidLinesFromContentLines -Lines $authLines)
  }
  if ($authLines.Count -eq 0 -and -not (Test-Path -LiteralPath $FilePath)) {
    return
  }
  $pidLines = Format-TokenPidSectionLines -PidMap $merged
  $allLines = @($authLines)
  if ($pidLines.Count -gt 0) {
    if ($allLines.Count -gt 0) {
      $allLines += ""
    }
    $allLines += $pidLines
  }
  $parent = Split-Path -Parent $FilePath
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  if ($allLines.Count -eq 0) {
    if (Test-Path -LiteralPath $FilePath) {
      Remove-Item -LiteralPath $FilePath -Force -ErrorAction SilentlyContinue
    }
    return
  }
  Set-Content -LiteralPath $FilePath -Value $allLines -Encoding utf8
}


function Clear-TokenFilePidSection {
  param([string]$FilePath)
  if (-not $FilePath -or -not (Test-Path -LiteralPath $FilePath)) {
    return
  }
  $lines = @(Get-Content -LiteralPath $FilePath -ErrorAction SilentlyContinue)
  $authLines = @(Remove-TokenPidLinesFromContentLines -Lines $lines)
  if ($authLines.Count -eq 0) {
    Remove-Item -LiteralPath $FilePath -Force -ErrorAction SilentlyContinue
    return
  }
  Set-Content -LiteralPath $FilePath -Value $authLines -Encoding utf8
}
