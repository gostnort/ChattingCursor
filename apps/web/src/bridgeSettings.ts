/** Bridge / 网页端口 localStorage 键与默认值 */
export const BRIDGE_PORT_KEY = "bridgePort";
export const WEB_PORT_KEY = "webPort";
export const LEGACY_BRIDGE_URL_KEY = "bridgeUrl";
export const DEFAULT_BRIDGE_PORT = 3000;
export const DEFAULT_WEB_PORT = 5173;
const BRIDGE_HOST = "127.0.0.1";


/** 解析正整数端口，无效时返回默认值 */
function parsePort(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}


/** 从 localStorage 读取 Bridge 端口（兼容旧 bridgeUrl） */
export function getBridgePort(): number {
  const storedPort = localStorage.getItem(BRIDGE_PORT_KEY);
  if (storedPort) {
    return parsePort(storedPort, DEFAULT_BRIDGE_PORT);
  }
  const legacyUrl = localStorage.getItem(LEGACY_BRIDGE_URL_KEY);
  if (legacyUrl) {
    try {
      const url = new URL(legacyUrl);
      const port = url.port ? Number.parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) {
        return port;
      }
    } catch {
      // 忽略无效 legacy URL
    }
  }
  return DEFAULT_BRIDGE_PORT;
}


/** 保存 Bridge 端口并同步 legacy bridgeUrl */
export function setBridgePort(port: number): void {
  localStorage.setItem(BRIDGE_PORT_KEY, String(port));
  localStorage.setItem(LEGACY_BRIDGE_URL_KEY, buildBridgeUrl(port));
}


/** 根据端口构建 Bridge URL */
export function buildBridgeUrl(port: number = getBridgePort()): string {
  return `http://${BRIDGE_HOST}:${port}`;
}


/** 读取网页（Vite dev）端口，仅作本地开发参考 */
export function getWebPort(): number {
  return parsePort(localStorage.getItem(WEB_PORT_KEY), DEFAULT_WEB_PORT);
}


/** 保存网页端口参考值 */
export function setWebPort(port: number): void {
  localStorage.setItem(WEB_PORT_KEY, String(port));
}


/** 清除已保存端口，恢复默认值 */
export function resetPortSettings(): { bridgePort: number; webPort: number } {
  localStorage.removeItem(BRIDGE_PORT_KEY);
  localStorage.removeItem(WEB_PORT_KEY);
  localStorage.removeItem(LEGACY_BRIDGE_URL_KEY);
  return { bridgePort: DEFAULT_BRIDGE_PORT, webPort: DEFAULT_WEB_PORT };
}


/** 当前保存值是否与默认端口一致 */
export function isDefaultPortSettings(): boolean {
  return getBridgePort() === DEFAULT_BRIDGE_PORT && getWebPort() === DEFAULT_WEB_PORT;
}


/** 构建本地开发前端 URL */
export function buildWebDevUrl(port: number = getWebPort()): string {
  return `http://${BRIDGE_HOST}:${port}/ChattingCursor/`;
}
