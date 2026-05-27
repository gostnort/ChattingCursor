/** 判断用户是否在请求联网搜索或核实（非本地聊天历史） */
export function hasWebSearchIntent(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.startsWith("/websearch ") || trimmed.startsWith("/google ")) {
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
  if (trimmed.startsWith("/websearch ")) {
    return trimmed.slice("/websearch ".length).trim();
  }
  if (trimmed.startsWith("/google ")) {
    return trimmed.slice("/google ".length).trim();
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
    endpoint: string;
    message?: string;
  },
): string {
  if (!result.ok) {
    return [
      `无法在 Chrome（${result.endpoint}）中打开 Google 搜索「${query}」。`,
      result.message ?? "请确认 Chrome 已启用远程调试端口 9222。",
      "",
      "启动示例（Windows）：",
      '  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222',
      "",
      `预备搜索链接：${result.searchUrl}`,
    ].join("\n");
  }
  const lines = [
    `已通过 Windows CDP（${result.endpoint}）在 Chrome 中打开 Google 搜索「${query}」。`,
    "",
    `搜索链接：${result.searchUrl}`,
  ];
  if (result.pageUrl && result.pageUrl !== result.searchUrl) {
    lines.push(`当前页面：${result.pageUrl}`);
  }
  if (result.title) {
    lines.push(`页面标题：${result.title}`);
  }
  if (result.excerpt) {
    lines.push("", "页面摘录（前 500 字）：", result.excerpt.slice(0, 500));
  }
  if (result.message) {
    lines.push("", result.message);
  }
  lines.push(
    "",
    "提示：联网搜索走 Bridge → Windows Chrome CDP（9222），非 WSL MCP。",
    "勿依赖 Kimi「auto」付费 API 联网；可用 /websearch、/google 或「网上搜一下…」。",
  );
  return lines.join("\n");
}
