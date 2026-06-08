/** Google SERP 摘录与回复摘要（可单测，不依赖 CDP） */

export interface GoogleSerpItem {
  title: string;
  url?: string;
  snippet?: string;
}


export interface GoogleSerpSnapshot {
  title?: string;
  url?: string;
  text?: string;
  items: GoogleSerpItem[];
  block?: "consent" | "captcha" | null;
}


export interface CrawledPageText {
  title: string;
  url: string;
  text: string;
}


export type GoogleAccessBlock = "consent" | "captcha";


const CHINESE_CHAR = /[\u4e00-\u9fff]/;


/** CDP Runtime.evaluate 用：抓取标题、正文、结果块与拦截页 */
export const GOOGLE_SERP_EXTRACT_EXPRESSION = `(() => {
  const href = location.href;
  const bodyText = (document.body && document.body.innerText) || "";
  const items = [];
  const seen = new Set();
  const unwrapGoogleHref = (raw) => {
    if (!raw) return "";
    try {
      const u = new URL(raw, location.origin);
      if (u.hostname.includes("google.") && u.pathname === "/url" && u.searchParams.has("q")) {
        const q = (u.searchParams.get("q") || "").trim();
        if (q.startsWith("http")) return q;
        return "";
      }
      if (u.protocol === "http:" || u.protocol === "https:") {
        if (u.hostname.includes("google.") && u.pathname.startsWith("/search")) return "";
        return u.href;
      }
    } catch (_) {}
    return "";
  };
  const findResultUrl = (node) => {
    const primary = node.querySelector(".yuRUbf a[href], .tF2Cxc a[href], a[jsname][href]");
    if (primary) {
      const url = unwrapGoogleHref(primary.href || primary.getAttribute("href") || "");
      if (url) return url;
    }
    for (const a of node.querySelectorAll("a[href]")) {
      const url = unwrapGoogleHref(a.href || a.getAttribute("href") || "");
      if (url) return url;
    }
    for (const a of node.querySelectorAll('a[href*="/url"], a[href^="/url"]')) {
      const url = unwrapGoogleHref(a.href || a.getAttribute("href") || "");
      if (url) return url;
    }
    const cite = node.querySelector("cite");
    if (cite) {
      const citeLink = cite.closest("a");
      if (citeLink) {
        const url = unwrapGoogleHref(citeLink.href || citeLink.getAttribute("href") || "");
        if (url) return url;
      }
    }
    const h3 = node.querySelector("h3");
    if (h3) {
      const parentLink = h3.closest("a");
      if (parentLink) {
        const url = unwrapGoogleHref(parentLink.href || parentLink.getAttribute("href") || "");
        if (url) return url;
      }
    }
    return "";
  };
  const selectors = [
    "#search .MjjYud",
    "#rso .MjjYud",
    ".MjjYud",
    "#search .tF2Cxc",
    ".tF2Cxc",
    "#search .g",
    "#rso .g",
    "div.g",
    "#search [data-sokoban-container]",
  ];
  const readTitle = (node) => {
    const h3 = node.querySelector("h3");
    if (h3) return (h3.innerText || "").trim();
    const lc20 = node.querySelector(".LC20lb, [role='heading']");
    if (lc20) return (lc20.innerText || lc20.textContent || "").trim();
    return "";
  };
  for (const sel of selectors) {
    for (const node of document.querySelectorAll(sel)) {
      const title = readTitle(node);
      if (!title || seen.has(title)) continue;
      const url = findResultUrl(node);
      const snippetEl = node.querySelector("[data-snf], .VwiC3b, .IsZvec, .st, .aCOpRe, .MUxGbd");
      const snippet = snippetEl ? (snippetEl.innerText || "").trim().slice(0, 400) : "";
      seen.add(title);
      items.push({ title, url, snippet });
      if (items.length >= 20) break;
    }
    if (items.length >= 20) break;
  }
  let block = null;
  const probe = bodyText + " " + href;
  if (/consent\\.google|Before you continue|accept all/i.test(probe)) block = "consent";
  else if (/unusual traffic|recaptcha|captcha-form|g-recaptcha|verify you are human/i.test(probe)) block = "captcha";
  return {
    title: document.title,
    url: href,
    text: bodyText.slice(0, 8000),
    items,
    block,
  };
})()`;


/** CDP：抓取整页 HTML，供 Python readability-lxml 提取正文 */
export const GOOGLE_PAGE_HTML_CAPTURE_EXPRESSION = `(() => ({
  title: document.title || "",
  url: location.href || "",
  html: (document.documentElement && document.documentElement.outerHTML) || ""
}))()`;


/** 根据 URL 与正文判断 Google 同意页 / 验证码 */
export function detectGoogleAccessBlock(pageUrl: string, bodyText: string): GoogleAccessBlock | null {
  const probe = `${bodyText}\n${pageUrl}`;
  if (/consent\.google|Before you continue|accept all/i.test(probe)) {
    return "consent";
  }
  if (/unusual traffic|recaptcha|captcha-form|g-recaptcha|verify you are human/i.test(probe)) {
    return "captcha";
  }
  return null;
}


/** 解析 CDP evaluate 返回值 */
export function parseGoogleSerpEvaluateValue(value: unknown): GoogleSerpSnapshot {
  if (!value || typeof value !== "object") {
    return { items: [] };
  }
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title : undefined;
  const url = typeof record.url === "string" ? record.url : undefined;
  const text = typeof record.text === "string" ? record.text : undefined;
  const block = record.block === "consent" || record.block === "captcha" ? record.block : null;
  const items: GoogleSerpItem[] = [];
  if (Array.isArray(record.items)) {
    for (const raw of record.items) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const item = raw as Record<string, unknown>;
      const itemTitle = typeof item.title === "string" ? item.title.trim() : "";
      if (!itemTitle) {
        continue;
      }
      items.push({
        title: itemTitle,
        url: typeof item.url === "string" ? item.url : undefined,
        snippet: typeof item.snippet === "string" ? item.snippet.trim() : undefined,
      });
    }
  }
  const resolvedBlock = block ?? (url && text ? detectGoogleAccessBlock(url, text) : null);
  return { title, url, text, items, block: resolvedBlock };
}


/** 查询是否以中文回复为主 */
export function preferChineseWebSearchReply(query: string): boolean {
  return CHINESE_CHAR.test(query);
}


/** 根据用户意图、搜索词或完整输入判断回复是否用中文 */
export function resolveWebSearchReplyLanguage(
  query: string,
  userIntent?: string,
  fullPrompt?: string,
): boolean {
  if (preferChineseWebSearchReply(userIntent ?? "")) {
    return true;
  }
  if (preferChineseWebSearchReply(query)) {
    return true;
  }
  if (fullPrompt && preferChineseWebSearchReply(fullPrompt)) {
    return true;
  }
  return false;
}


/** 从 SERP 条目 href 列表中选出首个可抓取的有机结果 URL */
export function pickOrganicUrlFromSerpHrefs(hrefs: string[]): string {
  for (const raw of hrefs) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const candidates = trimmed.startsWith("http")
      ? [trimmed]
      : [trimmed, `https://www.google.com${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`];
    for (const candidate of candidates) {
      const normalized = normalizeOrganicResultUrl(candidate);
      if (normalized) {
        return normalized;
      }
    }
  }
  return "";
}


/** 将 SERP 链接规范为可抓取的 http(s) URL；Google 跳转链会解包 */
export function normalizeOrganicResultUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("http")) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.includes("google.") && parsed.pathname === "/url" && parsed.searchParams.has("q")) {
      const unwrapped = parsed.searchParams.get("q")?.trim() ?? "";
      return unwrapped.startsWith("http") ? unwrapped : null;
    }
    if (parsed.hostname.includes("google.") && parsed.pathname.startsWith("/search")) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}


/** 从 SERP 条目中收集未见的有机结果 URL（受每页与总量上限约束） */
export function collectNewOrganicResultUrls(
  items: GoogleSerpItem[],
  seenUrls: Set<string>,
  limits: { perPageMax: number; totalMax: number; alreadyQueued: number },
): { urls: string[]; truncated: boolean } {
  const urls: string[] = [];
  let truncated = false;
  for (const item of items) {
    const href = pickOrganicUrlFromSerpHrefs([item.url ?? ""]);
    if (!href || seenUrls.has(href)) {
      continue;
    }
    urls.push(href);
    if (urls.length >= limits.perPageMax) {
      truncated = true;
      break;
    }
  }
  const remaining = limits.totalMax - limits.alreadyQueued;
  if (urls.length > remaining) {
    truncated = true;
    return { urls: urls.slice(0, Math.max(0, remaining)), truncated };
  }
  if (limits.alreadyQueued + urls.length >= limits.totalMax) {
    truncated = truncated || urls.length > 0;
  }
  return { urls, truncated };
}


/** Fisher–Yates 原地洗牌（用于随机抽样 SERP 链接） */
function shuffleInPlace<T>(items: T[]): void {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const temp = items[index];
    items[index] = items[swapIndex];
    items[swapIndex] = temp;
  }
}


/** 从 SERP 条目中随机抽取未见有机结果 URL（受每页与总量上限约束） */
export function collectRandomNewOrganicResultUrls(
  items: GoogleSerpItem[],
  seenUrls: Set<string>,
  limits: { perPageMax: number; totalMax: number; alreadyQueued: number },
): { urls: string[]; truncated: boolean } {
  const eligible: string[] = [];
  for (const item of items) {
    const href = pickOrganicUrlFromSerpHrefs([item.url ?? ""]);
    if (!href || seenUrls.has(href)) {
      continue;
    }
    eligible.push(href);
  }
  shuffleInPlace(eligible);
  const picked = eligible.slice(0, limits.perPageMax);
  const remaining = limits.totalMax - limits.alreadyQueued;
  if (picked.length > remaining) {
    return { urls: picked.slice(0, Math.max(0, remaining)), truncated: true };
  }
  const truncated = picked.length >= limits.perPageMax && eligible.length > limits.perPageMax;
  return { urls: picked, truncated };
}


/** 由 DOM 结果块生成结构化摘要（不依赖付费 API） */
export function buildStructuredSerpSummary(query: string, snapshot: GoogleSerpSnapshot): string {
  const zh = preferChineseWebSearchReply(query);
  const lines: string[] = [];
  if (snapshot.block === "consent") {
    lines.push(
      zh
        ? "Google 显示 Cookie/隐私同意页，自动化无法读取搜索结果。请在 Chrome 中手动点「接受」或登录后再试。"
        : "Google showed a consent interstitial; accept cookies in Chrome and retry.",
    );
    return lines.join("\n");
  }
  if (snapshot.block === "captcha") {
    lines.push(
      zh
        ? "Google 要求人机验证（验证码 / unusual traffic），无法自动摘录。请在 Chrome 中完成验证后重试 /websearch。"
        : "Google CAPTCHA or unusual-traffic check blocked automated extraction. Complete it in Chrome and retry.",
    );
    return lines.join("\n");
  }
  if (snapshot.items.length > 0) {
    for (const item of snapshot.items.slice(0, 8)) {
      const parts = [`- **${item.title}**`];
      if (item.snippet) {
        parts.push(` — ${item.snippet.replace(/\s+/g, " ").slice(0, 220)}`);
      }
      lines.push(parts.join(""));
      if (item.url) {
        lines.push(`  ${item.url}`);
      }
    }
    return lines.join("\n");
  }
  const fallback = (snapshot.text ?? "").replace(/\s+/g, " ").trim();
  if (fallback) {
    lines.push(
      zh
        ? `（未解析到标准结果块，以下为页面正文摘录）\n${fallback.slice(0, 1200)}`
        : `(No structured result blocks; page excerpt)\n${fallback.slice(0, 1200)}`,
    );
    return lines.join("\n");
  }
  return zh
    ? "未能从当前页面解析到搜索结果，请查看 Chrome 标签页。"
    : "Could not parse search results from the page; check the Chrome tab.";
}

