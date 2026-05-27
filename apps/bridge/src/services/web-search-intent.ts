import {
  buildStructuredSerpSummary,
  preferChineseWebSearchReply,
  type GoogleSerpItem,
} from "./google-serp-parse.js";

const WEBSEARCH_PREFIX = /^\/websearch\s+/i;
const GOOGLE_PREFIX = /^\/google\s+/i;


/** 判断用户是否在请求联网搜索或核实（非本地聊天历史） */
export function hasWebSearchIntent(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (WEBSEARCH_PREFIX.test(trimmed) || GOOGLE_PREFIX.test(trimmed)) {
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


/** 从自然语言或 /websearch、/google 指令中提取联网搜索关键词 */
export function extractWebSearchQuery(prompt: string): string {
  const trimmed = prompt.trim();
  const websearchMatch = WEBSEARCH_PREFIX.exec(trimmed);
  if (websearchMatch) {
    return trimmed.slice(websearchMatch[0].length).trim();
  }
  const googleMatch = GOOGLE_PREFIX.exec(trimmed);
  if (googleMatch) {
    return trimmed.slice(googleMatch[0].length).trim();
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
  const snapshot = {
    title: result.title,
    url: sourceUrl,
    text: result.excerpt,
    items: result.serpItems ?? [],
    block: result.block ?? null,
  };
  const structured = buildStructuredSerpSummary(query, snapshot);
  const lines = [
    summaryHeading,
    "",
    zh ? `关键词：${query}` : `Query: ${query}`,
    "",
    structured,
  ];
  if (result.aiSummary?.trim()) {
    lines.push("", zh ? "### AI 补充摘要" : "### AI summary", "", result.aiSummary.trim());
  }
  if (result.title) {
    lines.push("", `${zh ? "页面标题" : "Page title"}：${result.title}`);
  }
  lines.push(
    "",
    `${zh ? "来源" : "Source"}：${sourceUrl}`,
    "",
    zh
      ? `已在 Chrome（${result.endpoint}）打开完整结果页。`
      : `Full results opened in Chrome (${result.endpoint}).`,
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
