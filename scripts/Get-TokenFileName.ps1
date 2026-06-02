# 与 bridge paths.ts 一致的 token 文件名

function Get-ShortHostnameForTokenFile {
  $raw = [System.Environment]::MachineName
  if (-not $raw -or -not $raw.Trim()) {
    $raw = $env:COMPUTERNAME
  }
  if (-not $raw -or -not $raw.Trim()) {
    $raw = "unknown"
  }
  $short = $raw.Trim()
  $dot = $short.IndexOf(".")
  if ($dot -gt 0) {
    $short = $short.Substring(0, $dot)
  }
  return Sanitize-HostnameForTokenFile $short
}


function Sanitize-HostnameForTokenFile {
  param([string]$Hostname)
  $trimmed = $Hostname.Trim()
  if (-not $trimmed) {
    return "unknown"
  }
  $invalid = [regex]'[<>:"/\\|?*\x00-\x1f]|\s'
  $sanitized = [regex]::Replace($trimmed, $invalid, "_")
  $sanitized = $sanitized.TrimStart(".").TrimEnd(".")
  if (-not $sanitized) {
    return "unknown"
  }
  if ($sanitized.Length -gt 63) {
    return $sanitized.Substring(0, 63)
  }
  return $sanitized
}


function Get-ChattingCursorTokenFileName {
  $fromEnv = [Environment]::GetEnvironmentVariable("CHATTINGCURSOR_TOKEN_FILE_NAME")
  if ($fromEnv -and $fromEnv.Trim()) {
    return $fromEnv.Trim()
  }
  $shortHost = Get-ShortHostnameForTokenFile
  return "chattingcursor-${shortHost}-token.txt"
}


function Get-ChattingCursorTokenFilePath {
  param([string]$TokenSyncDir)
  return Join-Path $TokenSyncDir (Get-ChattingCursorTokenFileName)
}
