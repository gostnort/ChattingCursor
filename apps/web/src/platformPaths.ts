/** 浏览器端路径提示：按客户端 OS 显示 Windows 或 Unix 风格默认值 */

export function isLikelyWindowsClient(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const platform = navigator.platform ?? "";
  const ua = navigator.userAgent ?? "";
  return /Win/i.test(platform) || /Windows/i.test(ua);
}


export function defaultChattingCursorHomeHint(): string {
  return isLikelyWindowsClient() ? "%USERPROFILE%\\.chattingcursor" : "~/.chattingcursor";
}


export function defaultCloudflaredCredentialsHint(): string {
  return isLikelyWindowsClient()
    ? "%USERPROFILE%\\.cloudflared\\<tunnel-id>.json"
    : "~/.cloudflared/<tunnel-id>.json";
}


export function defaultCloudflareTunnelConfigHint(): string {
  if (isLikelyWindowsClient()) {
    return "%USERPROFILE%\\.chattingcursor\\cloudflare-tunnel.json";
  }
  return "~/.chattingcursor/cloudflare-tunnel.json";
}
