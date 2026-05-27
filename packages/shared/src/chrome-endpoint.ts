import { readFileSync } from "node:fs";

/** Chrome 远程调试默认地址（Windows 本机） */
export const DEFAULT_CHROME_DEBUG_ENDPOINT = "http://127.0.0.1:9222";


/** 解析 Chrome 调试 URL：环境变量优先；WSL 下将 localhost 改写为 Windows 主机 IP */
export function resolveChromeEndpoint(): string {
  const fromEnv = process.env.CHROME_DEBUG_ENDPOINT?.trim();
  const raw = fromEnv && fromEnv.length > 0
    ? fromEnv.replace(/\/$/, "")
    : DEFAULT_CHROME_DEBUG_ENDPOINT;
  return rewriteLocalhostForWsl(raw);
}


/** Bridge（run.bat / Windows Node）联网搜索用：固定本机 9222，不做 WSL 主机改写 */
export function resolveBridgeChromeEndpoint(): string {
  const fromEnv = process.env.CHROME_DEBUG_ENDPOINT?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv.replace(/\/$/, "");
  }
  return DEFAULT_CHROME_DEBUG_ENDPOINT;
}


function isWsl(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  if (process.env.WSL_DISTRO_NAME) {
    return true;
  }
  try {
    const version = readFileSync("/proc/version", "utf8");
    return /microsoft/i.test(version);
  } catch {
    return false;
  }
}


function readWslWindowsHost(): string | null {
  try {
    const resolv = readFileSync("/etc/resolv.conf", "utf8");
    const match = resolv.match(/^nameserver\s+(\S+)/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}


function rewriteLocalhostForWsl(endpoint: string): string {
  if (!isWsl()) {
    return endpoint;
  }
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    if (host !== "127.0.0.1" && host !== "localhost") {
      return endpoint;
    }
    const winHost = readWslWindowsHost();
    if (!winHost) {
      return endpoint;
    }
    url.hostname = winHost;
    return url.toString().replace(/\/$/, "");
  } catch {
    return endpoint;
  }
}
