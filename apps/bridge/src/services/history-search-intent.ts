/** 判断用户消息是否像在请求搜索本地聊天历史 */
export function hasHistorySearchIntent(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.startsWith("/search ")) {
    return true;
  }
  const intentPatterns = [
    /(?:帮我|请)?(?:找|搜|搜索|查找|查)(?:一下|下)?/,
    /(?:之前|以前|过往|历史).*(?:对话|聊天|记录|讨论)/,
    /(?:对话|聊天|记录).*(?:之前|以前|历史)/,
    /有没有.*(?:之前|以前|历史)/,
    /还记得.*(?:之前|以前|对话|聊天)/,
  ];
  return intentPatterns.some((pattern) => pattern.test(trimmed));
}


/** 从自然语言或 /search 指令中提取搜索关键词 */
export function extractSearchKeywords(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.startsWith("/search ")) {
    return trimmed.slice("/search ".length).trim();
  }
  const topicPatterns = [
    /(?:帮我|请)?(?:找|搜|搜索|查找|查)(?:一下|下)?(?:之前)?(?:关于|有关)?(.+?)(?:的)?(?:对话|聊天记录|历史|记录|讨论)/,
    /(?:有没有|还记得)(?:之前)?(?:关于|有关)?(.+?)(?:的)?(?:对话|聊天|讨论|记录)/,
    /(?:搜索|查找)(?:一下|下)?(?:本地)?(?:历史|记录)?[：:]\s*(.+)/,
    /(?:之前|以前).*(?:关于|有关)(.+?)(?:的)?(?:对话|聊天|讨论)/,
  ];
  for (const pattern of topicPatterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  const stopWords = new Set([
    "帮我", "请", "找", "搜", "搜索", "查找", "查", "一下", "之前", "以前", "过往",
    "关于", "有关", "的", "对话", "聊天", "记录", "历史", "讨论", "有没有", "还记得",
    "本地", "之前聊过", "聊过",
  ]);
  const tokens = trimmed
    .replace(/[，。！？、；：""''（）]/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !stopWords.has(part));
  if (tokens.length > 0) {
    return tokens.join(" ");
  }
  return trimmed;
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
