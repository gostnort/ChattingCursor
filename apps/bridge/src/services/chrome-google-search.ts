/** 通过 Chrome 远程调试（默认 9222）在 Google 打开搜索页并摘录 SERP */

import { resolveBridgeChromeEndpoint } from "@chatting-cursor/shared/chrome-endpoint";
import {
  GOOGLE_SERP_EXTRACT_EXPRESSION,
  type GoogleSerpItem,
  parseGoogleSerpEvaluateValue,
} from "./google-serp-parse.js";
import { maybeSummarizeWebSearchWithSdk } from "./web-search-summarize.js";

const NAVIGATE_TIMEOUT_MS = 15000;
const CDP_SESSION_TIMEOUT_MS = 20000;
const EXCERPT_MAX_CHARS = 8000;


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
  serpItems?: GoogleSerpItem[];
  block?: "consent" | "captcha" | null;
  aiSummary?: string;
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


/** 在 Chrome 新标签页打开 Google 搜索，等待加载并摘录 SERP */
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
    const wsUrl = await resolveTargetWebSocket(endpoint, targetId);
    if (!wsUrl) {
      return {
        ok: false,
        endpoint,
        searchUrl,
        message: "已打开标签页，但无法获取 CDP WebSocket（无法导航或摘录）。",
      };
    }
    const snapshot = await captureGoogleSerpViaCdp(wsUrl, searchUrl);
    const structuredBullets = snapshot.serpItems
      ?.map((item) => `- ${item.title}${item.snippet ? `: ${item.snippet.slice(0, 120)}` : ""}`)
      .join("\n") ?? "";
    const aiSummary = snapshot.block
      ? undefined
      : await maybeSummarizeWebSearchWithSdk(query, snapshot.excerpt ?? "", structuredBullets);
    return {
      ok: true,
      endpoint,
      searchUrl,
      pageUrl: snapshot.url,
      title: snapshot.title,
      excerpt: snapshot.excerpt,
      serpItems: snapshot.serpItems,
      block: snapshot.block,
      aiSummary,
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


async function resolveTargetWebSocket(endpoint: string, targetId: string): Promise<string> {
  const deadline = Date.now() + NAVIGATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const target = await fetchTarget(endpoint, targetId);
    const wsUrl = typeof target?.webSocketDebuggerUrl === "string" ? target.webSocketDebuggerUrl : "";
    if (wsUrl) {
      return wsUrl;
    }
    await sleep(300);
  }
  return "";
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


interface CdpSerpCapture {
  url?: string;
  title?: string;
  excerpt?: string;
  serpItems?: GoogleSerpItem[];
  block?: "consent" | "captcha" | null;
  message?: string;
}


async function captureGoogleSerpViaCdp(webSocketDebuggerUrl: string, searchUrl: string): Promise<CdpSerpCapture> {
  const WebSocketCtor = globalThis.WebSocket as (typeof WebSocket | undefined);
  if (!WebSocketCtor) {
    return { message: "当前 Node 环境无 WebSocket，仅返回搜索链接。" };
  }
  return new Promise((resolve) => {
    const socket = new WebSocketCtor(webSocketDebuggerUrl);
    let settled = false;
    let nextId = 1;
    const pending = new Map<number, { resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void }>();
    const finish = (payload: CdpSerpCapture): void => {
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
    const sendCommand = (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const id = nextId++;
      return new Promise((commandResolve, commandReject) => {
        pending.set(id, {
          resolve: commandResolve,
          reject: commandReject,
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    };
    const timer = setTimeout(() => {
      finish({ message: "CDP 摘录超时，请在 Chrome 中查看搜索结果。" });
    }, CDP_SESSION_TIMEOUT_MS);
    const runSession = async (): Promise<void> => {
      await sendCommand("Page.enable");
      await sendCommand("Runtime.enable");
      const current = await sendCommand("Runtime.evaluate", {
        expression: "({ url: location.href, ready: document.readyState })",
        returnByValue: true,
      });
      const currentValue = readEvaluateValue(current) as { url?: string; ready?: string } | undefined;
      const href = typeof currentValue?.url === "string" ? currentValue.url : "";
      const needsNavigate = !href || href === "about:blank" || !href.includes("google.");
      if (needsNavigate) {
        await sendCommand("Page.navigate", { url: searchUrl });
        await waitForGooglePageLoad(sendCommand, searchUrl);
      } else {
        await waitForDocumentReady(sendCommand);
      }
      const extractResponse = await sendCommand("Runtime.evaluate", {
        expression: GOOGLE_SERP_EXTRACT_EXPRESSION,
        returnByValue: true,
      });
      const parsed = parseGoogleSerpEvaluateValue(readEvaluateValue(extractResponse));
      clearTimeout(timer);
      finish({
        url: parsed.url,
        title: parsed.title,
        excerpt: parsed.text?.slice(0, EXCERPT_MAX_CHARS),
        serpItems: parsed.items,
        block: parsed.block,
      });
    };
    socket.addEventListener("open", () => {
      void runSession().catch((error: unknown) => {
        clearTimeout(timer);
        const detail = error instanceof Error ? error.message : String(error);
        finish({ message: `CDP 会话失败：${detail}` });
      });
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const id = typeof payload.id === "number" ? payload.id : 0;
      const waiter = pending.get(id);
      if (!waiter) {
        return;
      }
      pending.delete(id);
      if (payload.error && typeof payload.error === "object") {
        const message = typeof (payload.error as Record<string, unknown>).message === "string"
          ? (payload.error as Record<string, unknown>).message as string
          : "CDP error";
        waiter.reject(new Error(message));
        return;
      }
      waiter.resolve(payload);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      finish({ message: "CDP WebSocket 连接失败，请在 Chrome 中查看搜索结果。" });
    });
  });
}


function readEvaluateValue(response: Record<string, unknown>): unknown {
  const result = response.result as Record<string, unknown> | undefined;
  const inner = result?.result as Record<string, unknown> | undefined;
  return inner?.value;
}


async function waitForGooglePageLoad(
  sendCommand: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  searchUrl: string,
): Promise<void> {
  const expectedHost = "google.";
  const deadline = Date.now() + NAVIGATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await sendCommand("Runtime.evaluate", {
      expression: "({ url: location.href, ready: document.readyState })",
      returnByValue: true,
    });
    const value = readEvaluateValue(response) as { url?: string; ready?: string } | undefined;
    const url = typeof value?.url === "string" ? value.url : "";
    const ready = typeof value?.ready === "string" ? value.ready : "";
    if (url && url !== "about:blank" && url.includes(expectedHost) && (ready === "interactive" || ready === "complete")) {
      await sleep(600);
      return;
    }
    if (url.startsWith(searchUrl.split("?")[0] ?? "") && ready === "complete") {
      await sleep(600);
      return;
    }
    await sleep(400);
  }
}


async function waitForDocumentReady(
  sendCommand: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const response = await sendCommand("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    const ready = readEvaluateValue(response);
    if (ready === "complete" || ready === "interactive") {
      await sleep(400);
      return;
    }
    await sleep(300);
  }
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
