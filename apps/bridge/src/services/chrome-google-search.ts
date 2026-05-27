/** 通过 Chrome 远程调试（默认 9222）在 Google 打开搜索页 */

import { resolveBridgeChromeEndpoint } from "@chatting-cursor/shared/chrome-endpoint";

const NAVIGATE_TIMEOUT_MS = 15000;


export interface ChromeEndpointStatus {
  available: boolean;
  endpoint: string;
  pages?: number;
  message?: string;
}


export interface ChromeGoogleSearchResult {
  ok: boolean;
  endpoint: string;
  searchUrl: string;
  pageUrl?: string;
  title?: string;
  excerpt?: string;
  message?: string;
}


/** 构建 Google 搜索 URL */
export function buildGoogleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}


/** 探测 Chrome 9222 是否可用 */
export async function inspectChromeEndpoint(): Promise<ChromeEndpointStatus> {
  const endpoint = resolveBridgeChromeEndpoint();
  try {
    const response = await fetch(`${endpoint}/json/list`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return {
        available: false,
        endpoint,
        message: `Chrome 9222 返回 HTTP ${response.status}`,
      };
    }
    const pages = await response.json() as unknown;
    if (!Array.isArray(pages)) {
      return {
        available: false,
        endpoint,
        message: "Chrome 9222 返回格式无效。",
      };
    }
    return {
      available: true,
      endpoint,
      pages: pages.length,
      message: "Chrome 9222 可用。",
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      endpoint,
      message: `无法连接 Chrome 9222：${detail}`,
    };
  }
}


/** 在 Chrome 新标签页打开 Google 搜索，并尝试读取标题与正文摘录 */
export async function openGoogleSearchInChrome(query: string): Promise<ChromeGoogleSearchResult> {
  const endpoint = resolveBridgeChromeEndpoint();
  const searchUrl = buildGoogleSearchUrl(query);
  const chrome = await inspectChromeEndpoint();
  if (!chrome.available) {
    return {
      ok: false,
      endpoint,
      searchUrl,
      message: chrome.message,
    };
  }
  try {
    const created = await openTab(endpoint, searchUrl);
    const targetId = typeof created.id === "string" ? created.id : "";
    const pageUrl = typeof created.url === "string" ? created.url : searchUrl;
    await waitForPageLoad(endpoint, targetId, searchUrl);
    const snapshot = await readPageSnapshot(endpoint, targetId);
    return {
      ok: true,
      endpoint,
      searchUrl,
      pageUrl: snapshot.url ?? pageUrl,
      title: snapshot.title,
      excerpt: snapshot.excerpt,
      message: snapshot.message,
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      endpoint,
      searchUrl,
      message: detail,
    };
  }
}


async function openTab(endpoint: string, url: string): Promise<Record<string, unknown>> {
  // buildGoogleSearchUrl 已对 q 做 encodeURIComponent；此处勿再 encodeURI/encodeURIComponent（会二次编码 %）
  const response = await fetch(`${endpoint}/json/new?${url}`, {
    method: "PUT",
    signal: AbortSignal.timeout(NAVIGATE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`打开新标签失败：HTTP ${response.status}`);
  }
  const payload = await response.json() as unknown;
  if (!payload || typeof payload !== "object") {
    throw new Error("打开新标签返回无效 JSON。");
  }
  return payload as Record<string, unknown>;
}


async function waitForPageLoad(endpoint: string, targetId: string, expectedUrl: string): Promise<void> {
  const deadline = Date.now() + NAVIGATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const target = await fetchTarget(endpoint, targetId);
    const url = typeof target?.url === "string" ? target.url : "";
    if (url && url !== "about:blank" && (url.includes("google.") || url.startsWith(expectedUrl.split("?")[0] ?? ""))) {
      return;
    }
    await sleep(400);
  }
}


async function fetchTarget(endpoint: string, targetId: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${endpoint}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    return null;
  }
  const pages = await response.json() as unknown;
  if (!Array.isArray(pages)) {
    return null;
  }
  for (const item of pages) {
    if (item && typeof item === "object" && (item as Record<string, unknown>).id === targetId) {
      return item as Record<string, unknown>;
    }
  }
  return null;
}


async function readPageSnapshot(
  endpoint: string,
  targetId: string,
): Promise<{ url?: string; title?: string; excerpt?: string; message?: string }> {
  const target = await fetchTarget(endpoint, targetId);
  const wsUrl = typeof target?.webSocketDebuggerUrl === "string" ? target.webSocketDebuggerUrl : "";
  if (!wsUrl) {
    return { message: "已打开标签页，但无法读取页面摘录（缺少 WebSocket 调试地址）。" };
  }
  return readSnapshotViaCdp(wsUrl);
}


async function readSnapshotViaCdp(
  webSocketDebuggerUrl: string,
): Promise<{ url?: string; title?: string; excerpt?: string; message?: string }> {
  const WebSocketCtor = globalThis.WebSocket as (typeof WebSocket | undefined);
  if (!WebSocketCtor) {
    return { message: "当前 Node 环境无 WebSocket，仅返回搜索链接。" };
  }
  return new Promise((resolve) => {
    const socket = new WebSocketCtor(webSocketDebuggerUrl);
    let settled = false;
    const finish = (payload: { url?: string; title?: string; excerpt?: string; message?: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.close();
      } catch {
        // 忽略关闭错误
      }
      resolve(payload);
    };
    const timer = setTimeout(() => {
      finish({ message: "读取页面摘录超时，请在 Chrome 中查看搜索结果。" });
    }, 8000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
      socket.send(JSON.stringify({ id: 2, method: "Page.enable" }));
      socket.send(JSON.stringify({
        id: 3,
        method: "Runtime.evaluate",
        params: {
          expression: "({ title: document.title, url: location.href, text: (document.body?.innerText || '').slice(0, 2000) })",
          returnByValue: true,
        },
      }));
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      let payload: { id?: number; result?: { result?: { value?: { title?: string; url?: string; text?: string } } } };
      try {
        payload = JSON.parse(String(event.data)) as typeof payload;
      } catch {
        return;
      }
      if (payload.id !== 3) {
        return;
      }
      clearTimeout(timer);
      const value = payload.result?.result?.value;
      finish({
        url: value?.url,
        title: value?.title,
        excerpt: value?.text,
      });
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      finish({ message: "CDP WebSocket 连接失败，请在 Chrome 中查看搜索结果。" });
    });
  });
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
