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
  const selectors = ["#search .g", "#rso .g", "div.g"];
  for (const sel of selectors) {
    for (const node of document.querySelectorAll(sel)) {
      const h3 = node.querySelector("h3");
      if (!h3) continue;
      const title = (h3.innerText || "").trim();
      if (!title || seen.has(title)) continue;
      const link = h3.closest("a") || node.querySelector('a[href^="http"]');
      const url = link && link.href ? link.href : "";
      const snippetEl = node.querySelector("[data-snf], .VwiC3b, .IsZvec, .st, .aCOpRe");
      const snippet = snippetEl ? (snippetEl.innerText || "").trim().slice(0, 400) : "";
      seen.add(title);
      items.push({ title, url, snippet });
      if (items.length >= 8) break;
    }
    if (items.length >= 8) break;
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


/** CDP：摘录结果页正文（article/main，限长） */
export const GOOGLE_PAGE_MAIN_TEXT_EXPRESSION = `(() => {
  const pick = document.querySelector("article")
    || document.querySelector("main")
    || document.querySelector("[role='main']")
    || document.body;
  const text = ((pick && pick.innerText) || "").replace(/\\s+/g, " ").trim();
  return {
    title: document.title || "",
    url: location.href || "",
    text: text.slice(0, 4000),
  };
})()`;


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


/** 由 SERP 条目与已抓取页面正文生成规则摘要（不依赖 cursor-agent） */
export function buildSynthesizedSearchSummary(
  query: string,
  items: GoogleSerpItem[],
  pages: CrawledPageText[],
): string {
  const zh = preferChineseWebSearchReply(query);
  const bullets: string[] = [];
  const seen = new Set<string>();
  const pushBullet = (line: string): void => {
    const key = line.slice(0, 80);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    bullets.push(line);
  };
  for (const item of items.slice(0, 6)) {
    const snippet = (item.snippet ?? "").replace(/\s+/g, " ").trim();
    if (snippet) {
      pushBullet(`- ${item.title}：${snippet.slice(0, 140)}`);
    } else {
      pushBullet(`- ${item.title}`);
    }
    if (bullets.length >= 6) {
      break;
    }
  }
  for (const page of pages.slice(0, 3)) {
    const lead = page.text.replace(/\s+/g, " ").trim();
    if (!lead) {
      continue;
    }
    pushBullet(`- ${page.title}：${lead.slice(0, 160)}${lead.length > 160 ? "…" : ""}`);
    if (bullets.length >= 8) {
      break;
    }
  }
  if (bullets.length === 0) {
    return zh
      ? "（未能生成摘要，请查看下方结果列表或 Chrome 标签页。）"
      : "(No summary could be built; see result list or Chrome tab.)";
  }
  return bullets.join("\n");
}
