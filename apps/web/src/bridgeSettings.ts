import { isGitHubPages } from "./environment";

/** Bridge / 网页端口 localStorage 键与默认值 */
export const BRIDGE_PORT_KEY = "bridgePort";
export const WEB_PORT_KEY = "webPort";
export const LEGACY_BRIDGE_URL_KEY = "bridgeUrl";
export const REMOTE_BRIDGE_URL_KEY = "remoteBridgeUrl";
export const BRIDGE_TOKEN_KEY = "bridgeAccessToken";
export const DEFAULT_BRIDGE_PORT = 4321;
export const DEFAULT_WEB_PORT = 43210;
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


/** GitHub Pages 首次加载：清除 webPort 并确保 Bridge 默认指向本机 4321 */
export function initPortSettingsForEnvironment(): void {
  if (!isGitHubPages()) {
    return;
  }
  localStorage.removeItem(WEB_PORT_KEY);
}


/** 规范化 Bridge URL */
export function normalizeBridgeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/$/, "");
  }
}


/** 从 localStorage 读取 Bridge URL */
export function getBridgeUrl(): string {
  const storedUrl = localStorage.getItem(REMOTE_BRIDGE_URL_KEY)?.trim();
  if (storedUrl) {
    return normalizeBridgeUrl(storedUrl);
  }
  const legacyUrl = localStorage.getItem(LEGACY_BRIDGE_URL_KEY);
  if (legacyUrl) {
    return normalizeBridgeUrl(legacyUrl);
  }
  const storedPort = localStorage.getItem(BRIDGE_PORT_KEY);
  if (storedPort) {
    return buildBridgeUrl(parsePort(storedPort, DEFAULT_BRIDGE_PORT));
  }
  if (isGitHubPages()) {
    return "";
  }
  return buildBridgeUrl(DEFAULT_BRIDGE_PORT);
}


/** 保存 Bridge URL，并同步 legacy 值 */
export function setBridgeUrl(url: string): void {
  const normalized = normalizeBridgeUrl(url);
  if (!normalized) {
    return;
  }
  localStorage.setItem(REMOTE_BRIDGE_URL_KEY, normalized);
  localStorage.setItem(LEGACY_BRIDGE_URL_KEY, normalized);
  const port = readBridgePortFromUrl(normalized);
  if (port !== null) {
    localStorage.setItem(BRIDGE_PORT_KEY, String(port));
  }
}


/** 根据端口构建 Bridge URL */
export function buildBridgeUrl(port: number = getBridgePort()): string {
  return `http://${BRIDGE_HOST}:${port}`;
}


/** 从 Bridge URL 推导端口 */
function readBridgePortFromUrl(urlValue: string): number | null {
  try {
    const url = new URL(urlValue);
    const port = url.port ? Number.parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return port;
    }
  } catch {
    // 忽略无效 URL
  }
  return null;
}


/** 从当前 Bridge URL 推导端口 */
export function getBridgePort(): number {
  const explicit = localStorage.getItem(BRIDGE_PORT_KEY);
  if (explicit) {
    return parsePort(explicit, DEFAULT_BRIDGE_PORT);
  }
  return readBridgePortFromUrl(getBridgeUrl()) ?? DEFAULT_BRIDGE_PORT;
}


/** 仅更新本地 Bridge 端口配置 */
export function setBridgePort(port: number): void {
  localStorage.setItem(BRIDGE_PORT_KEY, String(port));
  const current = getBridgeUrl();
  if (current && isLocalBridgeUrl(current)) {
    setBridgeUrl(buildBridgeUrl(port));
    return;
  }
  localStorage.setItem(LEGACY_BRIDGE_URL_KEY, buildBridgeUrl(port));
}


/** 读取网页（Vite dev）端口，仅作本地开发参考；GitHub Pages 不使用 */
export function getWebPort(): number {
  if (isGitHubPages()) {
    return DEFAULT_WEB_PORT;
  }
  return parsePort(localStorage.getItem(WEB_PORT_KEY), DEFAULT_WEB_PORT);
}


/** 保存网页端口参考值；GitHub Pages 不写入 */
export function setWebPort(port: number): void {
  if (isGitHubPages()) {
    return;
  }
  localStorage.setItem(WEB_PORT_KEY, String(port));
}


/** 读取当前保存的 Bridge token */
export function getBridgeToken(): string {
  return localStorage.getItem(BRIDGE_TOKEN_KEY)?.trim() ?? "";
}


/** 保存 Bridge token */
export function setBridgeToken(token: string): void {
  const trimmed = token.trim();
  if (!trimmed) {
    localStorage.removeItem(BRIDGE_TOKEN_KEY);
    return;
  }
  localStorage.setItem(BRIDGE_TOKEN_KEY, trimmed);
}


/** 清空 Bridge token */
export function clearBridgeToken(): void {
  localStorage.removeItem(BRIDGE_TOKEN_KEY);
}


/** 清除已保存端口，恢复默认值 */
export function resetPortSettings(): { bridgePort: number; webPort: number } {
  localStorage.removeItem(BRIDGE_PORT_KEY);
  localStorage.removeItem(REMOTE_BRIDGE_URL_KEY);
  localStorage.removeItem(LEGACY_BRIDGE_URL_KEY);
  if (isGitHubPages()) {
    localStorage.removeItem(WEB_PORT_KEY);
    return { bridgePort: DEFAULT_BRIDGE_PORT, webPort: DEFAULT_WEB_PORT };
  }
  localStorage.removeItem(WEB_PORT_KEY);
  return { bridgePort: DEFAULT_BRIDGE_PORT, webPort: DEFAULT_WEB_PORT };
}


/** 当前保存值是否与默认端口一致 */
export function isDefaultPortSettings(): boolean {
  if (isGitHubPages()) {
    return getBridgePort() === DEFAULT_BRIDGE_PORT;
  }
  return getBridgePort() === DEFAULT_BRIDGE_PORT && getWebPort() === DEFAULT_WEB_PORT;
}


/** 构建本地开发前端 URL；GitHub Pages 不使用 */
export function buildWebDevUrl(port: number = getWebPort()): string {
  return `http://${BRIDGE_HOST}:${port}/ChattingCursor/`;
}


/** 判断 Bridge URL 是否指向本机 */
export function isLocalBridgeUrl(bridgeUrl: string): boolean {
  try {
    const url = new URL(normalizeBridgeUrl(bridgeUrl));
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}
