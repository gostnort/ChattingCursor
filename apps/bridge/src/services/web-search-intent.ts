import { resolveWebSearchReplyLanguage } from "./google-serp-parse.js";
import { webSearchQueryHash } from "./websearch-state.js";


/** formatWebSearchReply 使用的检索元信息（不含正文摘录） */
export interface WebSearchReplyMeta {
  endpoint: string;
  searchUrl: string;
  linksCrawled?: number;
  linksQueued?: number;
  serpStartOffsets?: number[];
}

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


/** 合并行内背景与会话中较早的用户消息，得到待回答的用户意图 */
export function extractWebSearchUserIntent(
  prompt: string,
  sessionMessages: { role: string; content: string }[] = [],
): string {
  const inline = extractWebSearchUserContext(prompt);
  if (inline) {
    return inline;
  }
  const trimmedPrompt = prompt.trim();
  const priorLines: string[] = [];
  for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
    const message = sessionMessages[index];
    if (message.role !== "user") {
      continue;
    }
    const content = message.content.trim();
    if (!content || content === trimmedPrompt) {
      continue;
    }
    const withoutSlash = content
      .replace(/\s*\/websearch\b[\s\S]*$/i, "")
      .replace(/\s*\/google\b[\s\S]*$/i, "")
      .trim();
    const candidate = withoutSlash || (/^\/(?:websearch|google)\b/i.test(content) ? "" : content);
    if (candidate) {
      priorLines.unshift(candidate);
    }
    if (priorLines.length >= 3) {
      break;
    }
  }
  return priorLines.join("\n").trim();
}


/** 统计当前会话中、当前消息之前出现过的同规范化搜索词次数 */
export function countEarlierSameWebSearchQueriesInSession(
  currentPrompt: string,
  sessionMessages: { role: string; content: string }[] = [],
): number {
  const trimmedPrompt = currentPrompt.trim();
  const currentQuery = extractWebSearchQuery(trimmedPrompt);
  if (!currentQuery.trim()) {
    return 0;
  }
  const currentKey = webSearchQueryHash(currentQuery);
  let count = 0;
  for (const message of sessionMessages) {
    if (message.role !== "user") {
      continue;
    }
    const content = message.content.trim();
    if (!content || content === trimmedPrompt) {
      continue;
    }
    const priorQuery = extractWebSearchQuery(content);
    if (!priorQuery.trim()) {
      continue;
    }
    if (webSearchQueryHash(priorQuery) === currentKey) {
      count += 1;
    }
  }
  return count;
}


/** 当前 /websearch 的 pass 序号 k（1-based，含本次） */
export function resolveSessionWebSearchPassK(
  currentPrompt: string,
  sessionMessages: { role: string; content: string }[] = [],
): number {
  return countEarlierSameWebSearchQueriesInSession(currentPrompt, sessionMessages) + 1;
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


function googleStartOffsetToPageNumber(start: number): number {
  if (start <= 0) {
    return 1;
  }
  return Math.floor(start / 10) + 1;
}


function buildWebSearchMetaFooter(meta: WebSearchReplyMeta, zh: boolean): string | undefined {
  const crawled = meta.linksCrawled ?? 0;
  const queued = meta.linksQueued ?? 0;
  const sourceCount = crawled > 0 ? crawled : queued;
  const offsets = meta.serpStartOffsets ?? [];
  if (sourceCount <= 0 && offsets.length === 0) {
    return undefined;
  }
  let pageSpan = "";
  if (offsets.length > 0) {
    const pages = offsets.map((offset) => googleStartOffsetToPageNumber(offset));
    const minPage = Math.min(...pages);
    const maxPage = Math.max(...pages);
    pageSpan = zh ? `，第 ${minPage}–${maxPage} 页` : `, pages ${minPage}–${maxPage}`;
  }
  if (sourceCount > 0) {
    return zh
      ? `（已检索 ${sourceCount} 个来源${pageSpan}）`
      : `(Searched ${sourceCount} source(s)${pageSpan})`;
  }
  return zh ? `（已检索 Google 结果${pageSpan}）` : `(Google SERP${pageSpan})`;
}


/** 按 OS 返回 Chrome 远程调试启动示例 */
function chromeRemoteDebugExample(): string {
  if (process.platform === "win32") {
    return '  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222';
  }
  if (process.platform === "darwin") {
    return "  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222";
  }
  return "  google-chrome --remote-debugging-port=9222";
}


/** 将联网搜索综合结果格式化为 assistant 回复（仅综合回答，不含原始摘录） */
export function formatWebSearchReply(
  userIntent: string,
  result: {
    ok: boolean;
    synthesis?: string;
    meta: WebSearchReplyMeta;
    message?: string;
  },
  fullPrompt?: string,
): string {
  const zh = resolveWebSearchReplyLanguage("", userIntent, fullPrompt);
  if (!result.ok) {
    return [
      zh
        ? `无法在 Chrome（${result.meta.endpoint}）中完成联网搜索。`
        : `Web search failed in Chrome (${result.meta.endpoint}).`,
      result.message ?? (zh ? "请确认 Chrome 已启用远程调试端口 9222。" : "Ensure Chrome remote debugging on port 9222."),
      "",
      zh ? "启动示例：" : "Example:",
      chromeRemoteDebugExample(),
    ].join("\n");
  }
  const heading = zh ? "## 回答" : "## Answer";
  const body = result.synthesis?.trim()
    || (zh ? "（未能根据检索结果生成回答，请稍后重试。）" : "(Could not synthesize an answer from sources.)");
  const lines = [heading, "", body];
  const footer = buildWebSearchMetaFooter(result.meta, zh);
  if (footer) {
    lines.push("", footer);
  }
  return lines.join("\n");
}
