import {
  buildStructuredSerpSummary,
  preferChineseWebSearchReply,
  type GoogleSerpItem,
} from "./google-serp-parse.js";

const SLASH_WEBSEARCH = /\/websearch\b/i;
const SLASH_GOOGLE = /\/google\b/i;
const LINE_WEBSEARCH_QUERY = /\/websearch\b\s*(.*)$/i;
const LINE_GOOGLE_QUERY = /\/google\b\s*(.*)$/i;


/** 从各行中提取 /websearch、/google 后的查询词（至行尾） */
function extractSlashCommandQueriesFromLines(prompt: string): string[] {
  const queries: string[] = [];
  for (const line of prompt.split(/\r?\n/)) {
    const webMatch = LINE_WEBSEARCH_QUERY.exec(line);
    if (webMatch) {
      const query = webMatch[1].trim();
      if (query) {
        queries.push(query);
      }
      continue;
    }
    const googleMatch = LINE_GOOGLE_QUERY.exec(line);
    if (googleMatch) {
      const query = googleMatch[1].trim();
      if (query) {
        queries.push(query);
      }
    }
  }
  return queries;
}


/** 消息任意位置是否包含 /websearch 或 /google 指令 */
function hasSlashWebSearchCommand(prompt: string): boolean {
  return SLASH_WEBSEARCH.test(prompt) || SLASH_GOOGLE.test(prompt);
}


/** 判断用户是否在请求联网搜索或核实（非本地聊天历史） */
export function hasWebSearchIntent(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return false;
  }
  if (hasSlashWebSearchCommand(trimmed)) {
    return true;
  }
  if (/^\/search\s+/i.test(trimmed)) {
    return false;
  }
  const webIntentPatterns = [
    /(?:帮我|请)?(?:搜索|搜|查)(?:一下|下)?(?:网页|网上|网络|互联网|在线)/,
    /(?:网页|网上|网络|互联网|在线).*(?:搜索|搜|查|找)/,
    /(?:联网|在线)(?:搜索|搜|查)/,
    /google(?:一下|搜|搜索)?/i,
    /(?:search|look\s+up).*(?:web|online|internet|google)/i,
    /(?:web|online)\s+search/i,
    /(?:核实|查证|验证|确认).*(?:一下|下)?(?:网上|网络|网页|是否|对不对|真伪)/,
    /(?:网上|网络|网页).*(?:核实|查证|验证|确认)/,
    /(?:查|搜)(?:一下|下)?(?:网上|网络).*(?:资料|信息|说法)/,
    /(?:有没有|是否).*(?:网上|网络).*(?:说法|报道|信息)/,
  ];
  return webIntentPatterns.some((pattern) => pattern.test(trimmed));
}


/** 提取 /websearch、/google 行前的用户背景（多行时取指令行之前的内容） */
export function extractWebSearchUserContext(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return "";
  }
  const lines = trimmed.split(/\r?\n/);
  const parts: string[] = [];
  for (const line of lines) {
    if (/\/websearch\b|\/google\b/i.test(line)) {
      const before = line
        .replace(/\s*\/websearch\b[\s\S]*$/i, "")
        .replace(/\s*\/google\b[\s\S]*$/i, "")
        .trim();
      if (before) {
        parts.push(before);
      }
      break;
    }
    parts.push(line.trim());
  }
  return parts.filter(Boolean).join("\n").trim();
}


/** 从自然语言或 /websearch、/google 指令中提取联网搜索关键词 */
export function extractWebSearchQuery(prompt: string): string {
  const trimmed = prompt.trim();
  const slashQueries = extractSlashCommandQueriesFromLines(trimmed);
  if (slashQueries.length > 0) {
    return slashQueries[0];
  }
  const topicPatterns = [
    /(?:帮我|请)?(?:搜索|搜|查)(?:一下|下)?(?:网页|网上|网络|互联网|在线)?[：:]\s*(.+)/,
    /(?:帮我|请)?(?:搜索|搜|查)(?:一下|下)?(?:网页|网上|网络|互联网|在线)?(.+?)(?:[。！？?]|$)/,
    /google(?:一下|搜|搜索)?[：:\s]+(.+?)(?:[。！？?]|$)/i,
    /(?:search|look\s+up)\s+(?:the\s+)?(?:web|online|internet|google)\s+(?:for\s+)?(.+?)(?:[.!?]|$)/i,
    /(?:核实|查证|验证|确认)(?:一下|下)?(.+?)(?:[。！？?]|$)/,
    /(?:查|搜)(?:一下|下)?(?:网上|网络)(?:关于|有关)?(.+?)(?:[。！？?]|$)/,
  ];
  for (const pattern of topicPatterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]?.trim()) {
      return cleanupQuery(match[1].trim());
    }
  }
  const stopWords = new Set([
    "帮我", "请", "搜索", "搜", "查", "查找", "一下", "网页", "网上", "网络", "互联网", "在线",
    "联网", "google", "核实", "查证", "验证", "确认", "关于", "有关", "的", "是否", "有没有",
    "资料", "信息", "说法", "报道",
  ]);
  const tokens = trimmed
    .replace(/[，。！？、；：""''（）]/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !stopWords.has(part.toLowerCase()) && !stopWords.has(part));
  if (tokens.length > 0) {
    return tokens.join(" ");
  }
  return cleanupQuery(trimmed);
}


function cleanupQuery(raw: string): string {
  return raw
    .replace(/^(?:一下|下|是否|有没有)\s*/u, "")
    .replace(/\s*(?:对不对|是否属实|真伪)$/u, "")
    .trim();
}


/** 将 Chrome 打开 Google 搜索的结果格式化为 assistant 回复 */
export function formatWebSearchReply(
  query: string,
  result: {
    ok: boolean;
    searchUrl: string;
    pageUrl?: string;
    title?: string;
    excerpt?: string;
    serpItems?: GoogleSerpItem[];
    crawledPages?: { title: string; url: string; text: string }[];
    synthesizedSummary?: string;
    serpPagesFetched?: number;
    serpStartOffsets?: number[];
    isRepeatSearch?: boolean;
    linksCrawled?: number;
    linksTruncated?: boolean;
    block?: "consent" | "captcha" | null;
    aiSummary?: string;
    endpoint: string;
    message?: string;
  },
): string {
  const zh = preferChineseWebSearchReply(query);
  if (!result.ok) {
    return [
      zh
        ? `无法在 Chrome（${result.endpoint}）中打开 Google 搜索「${query}」。`
        : `Could not open Google search for "${query}" in Chrome (${result.endpoint}).`,
      result.message ?? (zh ? "请确认 Chrome 已启用远程调试端口 9222。" : "Ensure Chrome remote debugging on port 9222."),
      "",
      zh ? "启动示例（Windows）：" : "Example (Windows):",
      '  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222',
      "",
      `${zh ? "预备搜索链接" : "Search URL"}：${result.searchUrl}`,
    ].join("\n");
  }
  const sourceUrl = result.pageUrl && result.pageUrl !== "about:blank" ? result.pageUrl : result.searchUrl;
  const summaryHeading = zh ? "## 搜索摘要" : "## Search summary";
  const resultsHeading = zh ? "## 搜索结果" : "## Search results";
  const snapshot = {
    title: result.title,
    url: sourceUrl,
    text: result.excerpt,
    items: result.serpItems ?? [],
    block: result.block ?? null,
  };
  const structured = buildStructuredSerpSummary(query, snapshot);
  const synthesis = result.aiSummary?.trim()
    ?? result.synthesizedSummary?.trim()
    ?? (result.block ? structured : "");
  const lines = [
    summaryHeading,
    "",
    zh ? `关键词：${query}` : `Query: ${query}`,
    "",
    synthesis || structured || (zh ? "（暂无摘要）" : "(No summary yet)"),
  ];
  if (!result.block) {
    lines.push("", resultsHeading, "", structured);
  }
  if (result.crawledPages && result.crawledPages.length > 0) {
    lines.push("", zh ? "### 已阅读页面摘录" : "### Pages read", "");
    for (const page of result.crawledPages) {
      const excerpt = page.text.replace(/\s+/g, " ").trim().slice(0, 280);
      lines.push(`- **${page.title}**`, `  ${page.url}`, excerpt ? `  ${excerpt}…` : "");
    }
  }
  if (result.serpStartOffsets && result.serpStartOffsets.length > 0) {
    const offsetNote = zh
      ? `（SERP start=${result.serpStartOffsets.join(",")}${result.isRepeatSearch ? "，续搜" : "，首次第2–3页"}）`
      : `(SERP start=${result.serpStartOffsets.join(",")}${result.isRepeatSearch ? ", continued" : ", first pages 2–3"})`;
    lines.push("", offsetNote);
  } else if (typeof result.serpPagesFetched === "number" && result.serpPagesFetched > 1) {
    lines.push("", zh ? `（已合并 ${result.serpPagesFetched} 页 Google 结果）` : `(Merged ${result.serpPagesFetched} SERP pages)`);
  }
  if (typeof result.linksCrawled === "number") {
    lines.push(
      "",
      zh
        ? `已阅读 ${result.linksCrawled} 个结果页${result.linksTruncated ? "（部分链接因上限未打开）" : ""}。`
        : `Read ${result.linksCrawled} result page(s)${result.linksTruncated ? " (some links skipped due to limits)" : ""}.`,
    );
  }
  if (result.title) {
    lines.push("", `${zh ? "页面标题" : "Page title"}：${result.title}`);
  }
  lines.push(
    "",
    `${zh ? "来源" : "Source"}：${sourceUrl}`,
    "",
    zh
      ? `已通过 Chrome（${result.endpoint}）完成搜索与摘录，相关标签页已自动关闭。`
      : `Search and extraction via Chrome (${result.endpoint}); opened tabs were closed.`,
  );
  if (result.message) {
    lines.push("", result.message);
  }
  lines.push(
    "",
    zh
      ? "提示：联网搜索走 Bridge → Windows Chrome CDP（9222），非 WSL MCP；勿依赖 Kimi「auto」付费 API。"
      : "Tip: web search uses Bridge → Windows Chrome CDP (9222), not WSL MCP or Kimi paid web.",
  );
  return lines.join("\n");
}
