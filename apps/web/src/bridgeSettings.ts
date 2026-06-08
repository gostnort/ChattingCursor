import { isGitHubPages, isLocalWebOrigin } from "./environment";


/** 将 fetch 网络错误转为中文提示（含 Bridge URL 与配置页指引） */
export function formatBridgeFetchError(bridgeUrl: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = normalizeBridgeUrl(bridgeUrl);
  const localTarget = isLocalBridgeUrl(normalized);
  const networkFailure = /failed to fetch|networkerror|network error|load failed|fetch resource/i.test(message);
  if (isLocalWebOrigin() && !localTarget && networkFailure) {
    return "你在本机浏览器打开页面，但 Bridge URL 指向远程地址。本地开发请改为 http://127.0.0.1:4321 并确认 Bridge 已启动；手机远程访问请改用 GitHub Pages 并粘贴 token 文件中的 publicBridgeUrl。";
  }
  if (isGitHubPages() && localTarget && networkFailure) {
    return "当前 Bridge URL 仍是 127.0.0.1 / localhost。若你现在用的是手机，127.0.0.1 指向的是手机自己，不是电脑；GitHub Pages 也不会自动找到你的电脑。请先给电脑上的 Bridge 配置一个可公开访问的 HTTPS 地址，再把这个地址填到 Bridge URL。";
  }
  if (isGitHubPages() && !localTarget && networkFailure) {
    return "远程 Bridge 当前不可达（隧道不可抵达）。请从云盘 token 文件复制最新的 publicBridgeUrl（须为 https://….trycloudflare.com），确认 run.bat 与 cloudflared 正在运行，并在本页保存后重试。";
  }
  if (isLocalWebOrigin() && localTarget && networkFailure) {
    return `无法连接 Bridge（${normalized}），请确认 run.bat 已启动。可在「配置」页检查 Bridge URL。`;
  }
  return message;
}

/** Bridge / 网页端口 localStorage 键与默认值 */
export const BRIDGE_PORT_KEY = "bridgePort";
export const WEB_PORT_KEY = "webPort";
export const LEGACY_BRIDGE_URL_KEY = "bridgeUrl";
export const LOCAL_BRIDGE_URL_KEY = "localBridgeUrl";
export const REMOTE_BRIDGE_URL_KEY = "remoteBridgeUrl";
export const BRIDGE_TOKEN_KEY = "bridgeAccessToken";
export const DEFAULT_BRIDGE_PORT = 4321;
export const DEFAULT_WEB_PORT = 43210;
const BRIDGE_HOST = "127.0.0.1";
/** 本机 Bridge 误保存为 HTTPS 默认端口或网页 dev 端口时，自动改回 4321 */
const INVALID_LOCAL_BRIDGE_PORTS = new Set([80, 443, DEFAULT_WEB_PORT]);


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


/** GitHub Pages 与本机 dev 首次加载：修正误存的 Bridge 端口 */
export function initPortSettingsForEnvironment(): void {
  if (isGitHubPages()) {
    localStorage.removeItem(WEB_PORT_KEY);
    return;
  }
  if (!isLocalWebOrigin()) {
    return;
  }
  const current = getStoredLocalBridgeUrlRaw();
  const repaired = repairLocalBridgeUrlIfNeeded(current);
  if (repaired !== current) {
    setBridgeUrl(repaired);
  }
}


/** 本机 loopback 上不应使用 HTTPS 默认端口或网页 dev 端口作为 Bridge */
function isPlausibleLocalBridgePort(port: number): boolean {
  if (port === DEFAULT_BRIDGE_PORT) {
    return true;
  }
  return !INVALID_LOCAL_BRIDGE_PORTS.has(port);
}


/** 将误存的 127.0.0.1:443 等本地 Bridge URL 改回默认端口 */
function repairLocalBridgeUrlIfNeeded(url: string): string {
  if (!url || !isLocalBridgeUrl(url)) {
    return url;
  }
  const port = readBridgePortFromUrl(url);
  if (port === null || isPlausibleLocalBridgePort(port)) {
    return url;
  }
  return buildBridgeUrl(DEFAULT_BRIDGE_PORT);
}


/** 读取 localStorage 中的本机 Bridge URL（不做自动修复） */
function getStoredLocalBridgeUrlRaw(): string {
  const localUrl = localStorage.getItem(LOCAL_BRIDGE_URL_KEY)?.trim();
  if (localUrl && isLocalBridgeUrl(localUrl)) {
    return normalizeBridgeUrl(localUrl);
  }
  const legacyUrl = localStorage.getItem(LEGACY_BRIDGE_URL_KEY)?.trim();
  if (legacyUrl && isLocalBridgeUrl(legacyUrl)) {
    return normalizeBridgeUrl(legacyUrl);
  }
  const storedPort = localStorage.getItem(BRIDGE_PORT_KEY);
  if (storedPort) {
    return buildBridgeUrl(parsePort(storedPort, DEFAULT_BRIDGE_PORT));
  }
  return buildBridgeUrl(DEFAULT_BRIDGE_PORT);
}


/** 规范化 Bridge URL */
export function normalizeBridgeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  let withProtocol = trimmed;
  if (!/^[a-z]+:\/\//i.test(trimmed)) {
    // 本机 loopback 无协议时用 http，避免误变成 https 导致 Failed to fetch
    withProtocol = /^(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(trimmed) ? `http://${trimmed}` : `https://${trimmed}`;
  }
  try {
    const url = new URL(withProtocol);
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/$/, "");
  }
}


/** 从 localStorage 读取本机 Bridge URL（仅 127.0.0.1 / localhost） */
function getStoredLocalBridgeUrl(): string {
  return repairLocalBridgeUrlIfNeeded(getStoredLocalBridgeUrlRaw());
}


/** 从 localStorage 读取远程 / 公网 Bridge URL */
function getStoredRemoteBridgeUrl(): string {
  const storedUrl = localStorage.getItem(REMOTE_BRIDGE_URL_KEY)?.trim();
  if (storedUrl) {
    return normalizeBridgeUrl(storedUrl);
  }
  const legacyUrl = localStorage.getItem(LEGACY_BRIDGE_URL_KEY)?.trim();
  if (legacyUrl && !isLocalBridgeUrl(legacyUrl)) {
    return normalizeBridgeUrl(legacyUrl);
  }
  return "";
}


/** 从 localStorage 读取当前环境应使用的 Bridge URL */
export function getBridgeUrl(): string {
  if (isLocalWebOrigin()) {
    return getStoredLocalBridgeUrl();
  }
  const remote = getStoredRemoteBridgeUrl();
  if (remote) {
    return remote;
  }
  if (isGitHubPages()) {
    return "";
  }
  return getStoredLocalBridgeUrl();
}


/** 保存 Bridge URL，并按本机 / 远程页面分别写入对应键 */
export function setBridgeUrl(url: string): void {
  const normalized = normalizeBridgeUrl(url);
  if (!normalized) {
    return;
  }
  localStorage.setItem(LEGACY_BRIDGE_URL_KEY, normalized);
  const port = readBridgePortFromUrl(normalized);
  if (port !== null) {
    localStorage.setItem(BRIDGE_PORT_KEY, String(port));
  }
  if (isLocalBridgeUrl(normalized)) {
    localStorage.setItem(LOCAL_BRIDGE_URL_KEY, normalized);
    if (isLocalWebOrigin()) {
      return;
    }
  }
  localStorage.setItem(REMOTE_BRIDGE_URL_KEY, normalized);
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
  const localUrl = buildBridgeUrl(port);
  localStorage.setItem(LOCAL_BRIDGE_URL_KEY, localUrl);
  localStorage.setItem(LEGACY_BRIDGE_URL_KEY, localUrl);
  if (isLocalWebOrigin()) {
    return;
  }
  const current = getStoredRemoteBridgeUrl();
  if (current && isLocalBridgeUrl(current)) {
    setBridgeUrl(localUrl);
  }
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
  localStorage.removeItem(LOCAL_BRIDGE_URL_KEY);
  localStorage.removeItem(REMOTE_BRIDGE_URL_KEY);
  localStorage.removeItem(LEGACY_BRIDGE_URL_KEY);
  if (isGitHubPages()) {
    localStorage.removeItem(WEB_PORT_KEY);
    return { bridgePort: DEFAULT_BRIDGE_PORT, webPort: DEFAULT_WEB_PORT };
  }
  localStorage.removeItem(WEB_PORT_KEY);
  return { bridgePort: DEFAULT_BRIDGE_PORT, webPort: DEFAULT_WEB_PORT };
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


/** 本机页面却配置了远程 Bridge URL（常见于误用 tunnel 地址） */
export function isLocalWebWithRemoteBridge(bridgeUrl: string): boolean {
  return isLocalWebOrigin() && !isLocalBridgeUrl(bridgeUrl);
}
