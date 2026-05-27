/** 通过 Chrome 远程调试（默认 9222）在 Google 打开搜索页并摘录 SERP */

import { resolveBridgeChromeEndpoint } from "@chatting-cursor/shared/chrome-endpoint";
import {
  GOOGLE_PAGE_MAIN_TEXT_EXPRESSION,
  GOOGLE_SERP_EXTRACT_EXPRESSION,
  buildSynthesizedSearchSummary,
  type CrawledPageText,
  type GoogleSerpItem,
  parseGoogleSerpEvaluateValue,
} from "./google-serp-parse.js";
import { maybeSummarizeWebSearchWithSdk } from "./web-search-summarize.js";

const NAVIGATE_TIMEOUT_MS = 15000;
const CDP_SESSION_TIMEOUT_MS = 25000;
const EXCERPT_MAX_CHARS = 8000;
const MAX_SERP_PAGES = 2;
const TOP_RESULTS_TO_CRAWL = 3;
const MIN_SERP_ITEMS_FOR_PAGE2 = 5;
const PAGE_TEXT_MAX_CHARS = 3500;


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
  crawledPages?: CrawledPageText[];
  synthesizedSummary?: string;
  serpPagesFetched?: number;
  block?: "consent" | "captcha" | null;
  aiSummary?: string;
  message?: string;
}


/** 构建 Google 搜索 URL（start 为分页偏移，0 表示第一页） */
export function buildGoogleSearchUrl(query: string, start = 0): string {
  const params = new URLSearchParams({ q: query });
  if (start > 0) {
    params.set("start", String(start));
  }
  return `https://www.google.com/search?${params.toString()}`;
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
  const createdTabIds: string[] = [];
  try {
    const created = await openTab(endpoint, searchUrl);
    const searchTargetId = typeof created.id === "string" ? created.id : "";
    if (searchTargetId) {
      createdTabIds.push(searchTargetId);
    }
    const wsUrl = await resolveTargetWebSocket(endpoint, searchTargetId);
    if (!wsUrl) {
      return {
        ok: false,
        endpoint,
        searchUrl,
        message: "已打开标签页，但无法获取 CDP WebSocket（无法导航或摘录）。",
      };
    }
    const serpCapture = await captureGoogleSerpMultiPage(wsUrl, query, searchUrl);
    const serpItems = serpCapture.serpItems ?? [];
    const crawlTargets = pickCrawlableResultUrls(serpItems, TOP_RESULTS_TO_CRAWL);
    const crawledPages: CrawledPageText[] = [];
    for (const targetUrl of crawlTargets) {
      const pageTab = await openTab(endpoint, targetUrl);
      const pageTargetId = typeof pageTab.id === "string" ? pageTab.id : "";
      if (pageTargetId) {
        createdTabIds.push(pageTargetId);
      }
      const pageWs = await resolveTargetWebSocket(endpoint, pageTargetId);
      if (!pageWs) {
        continue;
      }
      const pageText = await capturePageMainTextViaCdp(pageWs, targetUrl);
      if (pageText.text.trim()) {
        crawledPages.push({
          title: pageText.title || targetUrl,
          url: pageText.url || targetUrl,
          text: pageText.text.slice(0, PAGE_TEXT_MAX_CHARS),
        });
      }
    }
    const structuredBullets = serpItems
      .map((item) => `- ${item.title}${item.snippet ? `: ${item.snippet.slice(0, 120)}` : ""}`)
      .join("\n");
    const pageBullets = crawledPages
      .map((page) => `- ${page.title}: ${page.text.slice(0, 200)}`)
      .join("\n");
    const synthesizedSummary = serpCapture.block
      ? undefined
      : buildSynthesizedSearchSummary(query, serpItems, crawledPages);
    const aggregateExcerpt = [
      serpCapture.excerpt ?? "",
      ...crawledPages.map((page) => `${page.title}\n${page.text}`),
    ].join("\n\n").slice(0, EXCERPT_MAX_CHARS);
    const aiSummary = serpCapture.block
      ? undefined
      : await maybeSummarizeWebSearchWithSdk(
        query,
        aggregateExcerpt,
        [structuredBullets, pageBullets].filter(Boolean).join("\n"),
      );
    return {
      ok: true,
      endpoint,
      searchUrl,
      pageUrl: serpCapture.url,
      title: serpCapture.title,
      excerpt: serpCapture.excerpt,
      serpItems,
      crawledPages,
      synthesizedSummary,
      serpPagesFetched: serpCapture.pagesFetched,
      block: serpCapture.block,
      aiSummary,
      message: serpCapture.message,
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      endpoint,
      searchUrl,
      message: detail,
    };
  } finally {
    await closeCreatedTabs(endpoint, createdTabIds);
  }
}


function pickCrawlableResultUrls(items: GoogleSerpItem[], limit: number): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const raw = (item.url ?? "").trim();
    if (!raw.startsWith("http")) {
      continue;
    }
    let href = raw;
    try {
      const parsed = new URL(raw);
      if (parsed.hostname.includes("google.") && parsed.pathname === "/url" && parsed.searchParams.has("q")) {
        href = parsed.searchParams.get("q") ?? raw;
      }
      if (parsed.hostname.includes("google.") && parsed.pathname.startsWith("/search")) {
        continue;
      }
    } catch {
      continue;
    }
    if (seen.has(href)) {
      continue;
    }
    seen.add(href);
    urls.push(href);
    if (urls.length >= limit) {
      break;
    }
  }
  return urls;
}


async function openTab(endpoint: string, url: string): Promise<Record<string, unknown>> {
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


async function closeCreatedTabs(endpoint: string, targetIds: string[]): Promise<void> {
  for (const targetId of targetIds) {
    if (!targetId) {
      continue;
    }
    try {
      await fetch(`${endpoint}/json/close/${encodeURIComponent(targetId)}`, {
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // 忽略关闭失败，避免掩盖主流程错误
    }
  }
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
  pagesFetched?: number;
  message?: string;
}


async function captureGoogleSerpMultiPage(
  webSocketDebuggerUrl: string,
  query: string,
  firstPageUrl: string,
): Promise<CdpSerpCapture> {
  return withCdpSession(webSocketDebuggerUrl, CDP_SESSION_TIMEOUT_MS, async (sendCommand) => {
    await sendCommand("Page.enable");
    await sendCommand("Runtime.enable");
    const mergedItems: GoogleSerpItem[] = [];
    const seenTitles = new Set<string>();
    let lastSnapshot: ReturnType<typeof parseGoogleSerpEvaluateValue> | null = null;
    let pagesFetched = 0;
    const pageUrls = [firstPageUrl];
    if (MAX_SERP_PAGES > 1) {
      pageUrls.push(buildGoogleSearchUrl(query, 10));
    }
    for (let pageIndex = 0; pageIndex < pageUrls.length; pageIndex += 1) {
      if (pageIndex > 0 && mergedItems.length >= MIN_SERP_ITEMS_FOR_PAGE2) {
        break;
      }
      if (pageIndex > 0 && lastSnapshot?.block) {
        break;
      }
      const pageUrl = pageUrls[pageIndex] ?? firstPageUrl;
      await sendCommand("Page.navigate", { url: pageUrl });
      await waitForGooglePageLoad(sendCommand, pageUrl);
      const extractResponse = await sendCommand("Runtime.evaluate", {
        expression: GOOGLE_SERP_EXTRACT_EXPRESSION,
        returnByValue: true,
      });
      const parsed = parseGoogleSerpEvaluateValue(readEvaluateValue(extractResponse));
      lastSnapshot = parsed;
      pagesFetched += 1;
      for (const item of parsed.items) {
        if (seenTitles.has(item.title)) {
          continue;
        }
        seenTitles.add(item.title);
        mergedItems.push(item);
      }
      if (parsed.block) {
        break;
      }
    }
    return {
      url: lastSnapshot?.url,
      title: lastSnapshot?.title,
      excerpt: lastSnapshot?.text?.slice(0, EXCERPT_MAX_CHARS),
      serpItems: mergedItems,
      block: lastSnapshot?.block ?? null,
      pagesFetched,
    };
  });
}


interface PageTextCapture {
  title: string;
  url: string;
  text: string;
}


async function capturePageMainTextViaCdp(
  webSocketDebuggerUrl: string,
  targetUrl: string,
): Promise<PageTextCapture> {
  return withCdpSession(webSocketDebuggerUrl, CDP_SESSION_TIMEOUT_MS, async (sendCommand) => {
    await sendCommand("Page.enable");
    await sendCommand("Runtime.enable");
    const current = await sendCommand("Runtime.evaluate", {
      expression: "({ url: location.href, ready: document.readyState })",
      returnByValue: true,
    });
    const currentValue = readEvaluateValue(current) as { url?: string; ready?: string } | undefined;
    const href = typeof currentValue?.url === "string" ? currentValue.url : "";
    const needsNavigate = !href || href === "about:blank" || !href.startsWith("http");
    if (needsNavigate) {
      await sendCommand("Page.navigate", { url: targetUrl });
    }
    await waitForGenericPageLoad(sendCommand, targetUrl);
    const extractResponse = await sendCommand("Runtime.evaluate", {
      expression: GOOGLE_PAGE_MAIN_TEXT_EXPRESSION,
      returnByValue: true,
    });
    const value = readEvaluateValue(extractResponse) as Record<string, unknown> | undefined;
    return {
      title: typeof value?.title === "string" ? value.title : "",
      url: typeof value?.url === "string" ? value.url : targetUrl,
      text: typeof value?.text === "string" ? value.text : "",
    };
  });
}


type SendCommand = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;


async function withCdpSession<T>(
  webSocketDebuggerUrl: string,
  timeoutMs: number,
  run: (sendCommand: SendCommand) => Promise<T>,
): Promise<T> {
  const WebSocketCtor = globalThis.WebSocket as (typeof WebSocket | undefined);
  if (!WebSocketCtor) {
    throw new Error("当前 Node 环境无 WebSocket，无法执行 CDP。");
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocketCtor(webSocketDebuggerUrl);
    let settled = false;
    let nextId = 1;
    const pending = new Map<number, { resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void }>();
    const finish = (result: T): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.close();
      } catch {
        // 忽略关闭错误
      }
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.close();
      } catch {
        // 忽略关闭错误
      }
      reject(error);
    };
    const sendCommand: SendCommand = (method, params) => {
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
      fail(new Error("CDP 会话超时"));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      void run(sendCommand)
        .then((result) => {
          clearTimeout(timer);
          finish(result);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          const detail = error instanceof Error ? error : new Error(String(error));
          fail(detail);
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
      fail(new Error("CDP WebSocket 连接失败"));
    });
  });
}


function readEvaluateValue(response: Record<string, unknown>): unknown {
  const result = response.result as Record<string, unknown> | undefined;
  const inner = result?.result as Record<string, unknown> | undefined;
  return inner?.value;
}


async function waitForGooglePageLoad(
  sendCommand: SendCommand,
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


async function waitForGenericPageLoad(
  sendCommand: SendCommand,
  expectedUrl: string,
): Promise<void> {
  const deadline = Date.now() + NAVIGATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await sendCommand("Runtime.evaluate", {
      expression: "({ url: location.href, ready: document.readyState })",
      returnByValue: true,
    });
    const value = readEvaluateValue(response) as { url?: string; ready?: string } | undefined;
    const url = typeof value?.url === "string" ? value.url : "";
    const ready = typeof value?.ready === "string" ? value.ready : "";
    if (url && url !== "about:blank" && (ready === "interactive" || ready === "complete")) {
      if (!expectedUrl || url.startsWith("http")) {
        await sleep(500);
        return;
      }
    }
    await sleep(400);
  }
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
