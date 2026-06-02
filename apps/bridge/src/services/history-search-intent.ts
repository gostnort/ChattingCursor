/** 历史搜索停用词（问句套话，不宜作为检索词） */
const HISTORY_SEARCH_STOP_WORDS = new Set([
  "帮我", "请", "找", "搜", "搜索", "查找", "查", "一下", "之前", "以前", "过往",
  "关于", "有关", "的", "对话", "聊天", "记录", "历史", "讨论", "有没有", "还记得",
  "本地", "之前聊过", "聊过", "说过", "提到", "讲过", "吗", "呢", "啊",
  "每天", "希望", "多少", "什么", "哪个", "是否", "怎么", "如何", "为什么",
  "之前说过", "我说过", "你还记得", "记得",
]);


/** 判断用户消息是否像在请求搜索本地聊天历史（需明确提及历史/过往对话） */
export function hasHistorySearchIntent(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.startsWith("/search ")) {
    return true;
  }
  const historyIntentPatterns = [
    /(?:帮我|请)?找(?:一下|下)?(?:之前|以前|过往)/,
    /(?:帮我|请)?(?:搜|搜索|查找)(?:一下|下)?(?:之前|以前|过往|本地)?(?:的)?(?:对话|聊天|记录|历史)/,
    /(?:之前|以前|过往|历史).*(?:对话|聊天|记录|讨论)/,
    /(?:对话|聊天|记录).*(?:之前|以前|历史)/,
    /有没有.*(?:之前|以前|历史)/,
    /还记得.*(?:之前|以前|说过|提到|讲过|聊过|对话|聊天)/,
    /(?:本地)?历史(?:对话|聊天|记录)/,
    /(?:搜索|查找)(?:一下|下)?(?:本地)?(?:历史|聊天记录)/,
    /(?:帮我|请)?找(?:一下|下)?(?:之前|以前).*(?:关于|有关)/,
  ];
  return historyIntentPatterns.some((pattern) => pattern.test(trimmed));
}


/** 清理从问句中提取的主题片段 */
function cleanupHistorySearchTopic(raw: string): string {
  return raw
    .replace(/^我(?:之前|以前)?(?:说过|提到|讲过|聊过)[，,、]?\s*/u, "")
    .replace(/^(?:关于|有关)\s*/u, "")
    .replace(/[？?吗呢啊]+$/u, "")
    .trim();
}


/** 从中文主题中切出可用于 substring 检索的词组 */
function deriveChineseKeywords(topic: string): string[] {
  const results: string[] = [];
  const fillerPattern = /(?:每天|希望|多少|什么|哪个|是否|有没有|之前|以前|说过|提到|讲过|聊过|我还|记得)/gu;
  const stripped = topic.replace(fillerPattern, " ").replace(/\s+/g, " ").trim();
  const segments = stripped.match(/[\u4e00-\u9fffA-Za-z0-9]{2,12}/g) ?? [];
  for (const segment of segments) {
    if (!HISTORY_SEARCH_STOP_WORDS.has(segment)) {
      results.push(segment);
    }
  }
  const phrases = topic.match(/[\u4e00-\u9fff]{2,8}/g) ?? [];
  for (const phrase of phrases) {
    if (!HISTORY_SEARCH_STOP_WORDS.has(phrase)) {
      results.push(phrase);
    }
  }
  return results;
}


/** 从自然语言或 /search 指令中提取搜索关键词（展示用主词） */
export function extractSearchKeywords(prompt: string): string {
  const candidates = extractSearchKeywordCandidates(prompt);
  return candidates[0] ?? prompt.trim();
}


/** 提取一组检索词（优先主题，再拆中文词组；用于 OR 匹配） */
export function extractSearchKeywordCandidates(prompt: string): string[] {
  const trimmed = prompt.trim();
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (term: string): void => {
    const normalized = term.trim();
    if (normalized.length < 2) {
      return;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    ordered.push(normalized);
  };
  if (trimmed.startsWith("/search ")) {
    add(trimmed.slice("/search ".length).trim());
    return ordered;
  }
  const recallSaidMatch = trimmed.match(
    /还记得(?:我)?(?:之前|以前)?(?:说过|提到|讲过|聊过)[，,、]?\s*(.+?)[？?吗呢啊]?\s*$/u,
  );
  if (recallSaidMatch?.[1]?.trim()) {
    const topic = cleanupHistorySearchTopic(recallSaidMatch[1].trim());
    add(topic);
    for (const term of deriveChineseKeywords(topic)) {
      add(term);
    }
  }
  const topicPatterns = [
    /(?:帮我|请)?(?:找|搜|搜索|查找|查)(?:一下|下)?(?:之前|以前|过往)?(?:关于|有关)?(.+?)(?:的)?(?:对话|聊天记录|历史|记录|讨论)/,
    /(?:有没有|还记得)(?:之前|以前)?(?:关于|有关)?(.+?)(?:的)?(?:对话|聊天|讨论|记录)/,
    /(?:搜索|查找)(?:一下|下)?(?:本地)?(?:历史|记录)?[：:]\s*(.+)/,
    /(?:之前|以前).*(?:关于|有关)(.+?)(?:的)?(?:对话|聊天|讨论)/,
    /(?:帮我|请)?找(?:一下|下)?(?:之前|以前).*(?:关于|有关)(.+)/,
    /还记得(?:我)?(?:之前|以前)?(?:关于|有关)?(.+?)[？?吗呢啊]?\s*$/u,
  ];
  for (const pattern of topicPatterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]?.trim()) {
      const topic = cleanupHistorySearchTopic(match[1].trim());
      add(topic);
      for (const term of deriveChineseKeywords(topic)) {
        add(term);
      }
      break;
    }
  }
  const tokens = trimmed
    .replace(/[，。！？、；：""''（）]/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !HISTORY_SEARCH_STOP_WORDS.has(part));
  for (const token of tokens) {
    add(token);
    for (const term of deriveChineseKeywords(token)) {
      add(term);
    }
  }
  if (ordered.length === 0) {
    add(trimmed);
  }
  return ordered;
}


/** 在当前会话内存消息中搜索（补充尚未落盘或同会话上下文） */
export function searchSessionMessages(
  messages: Array<{ role: string; content: string }>,
  keywords: string[],
  sessionId: string,
  excludeContent?: string,
): Array<{ file: string; snippet: string; line?: number }> {
  const normalizedKeywords = keywords
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword.length >= 2);
  if (normalizedKeywords.length === 0) {
    return [];
  }
  const exclude = excludeContent?.trim();
  const hits: Array<{ file: string; snippet: string; line?: number }> = [];
  const sessionLabel = `${sessionId}.txt（当前会话）`;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const content = message.content.trim();
    if (!content || (exclude && content === exclude)) {
      continue;
    }
    const lower = content.toLowerCase();
    const matchedKeyword = normalizedKeywords.find((keyword) => lower.includes(keyword));
    if (!matchedKeyword) {
      continue;
    }
    const matchIndex = lower.indexOf(matchedKeyword);
    const start = Math.max(0, matchIndex - 80);
    const end = Math.min(content.length, matchIndex + matchedKeyword.length + 80);
    const roleLabel = message.role === "user" ? "User" : "Assistant";
    const snippet = `${roleLabel}: ${(start > 0 ? "…" : "")}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
    hits.push({ file: sessionLabel, snippet, line: index + 1 });
    if (hits.length >= 50) {
      break;
    }
  }
  return hits;
}


/** 合并磁盘与会话命中，会话结果优先展示 */
export function mergeHistorySearchHits(
  sessionHits: Array<{ file: string; snippet: string; line?: number }>,
  diskHits: Array<{ file: string; snippet: string; line?: number }>,
): Array<{ file: string; snippet: string; line?: number }> {
  const merged: Array<{ file: string; snippet: string; line?: number }> = [];
  const seen = new Set<string>();
  for (const hit of [...sessionHits, ...diskHits]) {
    const key = `${hit.file}\0${hit.snippet}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(hit);
    if (merged.length >= 50) {
      break;
    }
  }
  return merged;
}


/** 将历史搜索结果格式化为 assistant 回复文本 */
export function formatHistorySearchReply(
  query: string,
  hits: Array<{ file: string; snippet: string; line?: number }>,
): string {
  if (hits.length === 0) {
    return `在本地历史（近 7 天）中未找到与「${query}」相关的内容。`;
  }
  const lines = [
    `在本地历史（近 7 天）中找到 ${hits.length} 条与「${query}」相关的片段：`,
    "",
  ];
  for (const [index, hit] of hits.entries()) {
    lines.push(`${index + 1}. ${hit.file}${hit.line ? `:${hit.line}` : ""}`);
    lines.push(hit.snippet);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
