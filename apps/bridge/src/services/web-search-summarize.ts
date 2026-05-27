import { Agent } from "@cursor/sdk";
import { preferChineseWebSearchReply } from "./google-serp-parse.js";


const SUMMARIZE_TIMEOUT_MS = 90000;
const AGGREGATE_PROMPT_MAX_CHARS = 30000;


/** 若配置了 CURSOR_API_KEY，用 SDK 对聚合摘录做综合评述（失败则忽略） */
export async function maybeSummarizeWebSearchWithSdk(
  query: string,
  extractedText: string,
  structuredBullets: string,
  userContext?: string,
): Promise<string | undefined> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey || !extractedText.trim()) {
    return undefined;
  }
  const modelId = process.env.CURSOR_WEB_SEARCH_MODEL?.trim() || "composer-2";
  const zh = preferChineseWebSearchReply(query) || preferChineseWebSearchReply(userContext ?? "");
  const contextBlock = userContext?.trim()
    ? (zh ? `用户背景：${userContext.trim()}` : `User context: ${userContext.trim()}`)
    : "";
  const instruction = zh
    ? [
      "你是一位研究助手。请综合评述以下 Google 搜索后抓取的资料（SERP 摘要与各结果页正文摘录）。",
      "要求：结构清晰；归纳共识与分歧；标注可信度有限之处；直接回答用户关心的问题。",
      "使用中文回复；可用小标题与要点列表；不要编造未出现在材料中的具体事实。",
    ].join("\n")
    : [
      "You are a research assistant. Synthesize the following Google SERP snippets and crawled page excerpts.",
      "Be structured; note agreement vs disagreement; flag uncertainty; answer the user's underlying question.",
      "Use the same language as the query. Do not invent facts not present in the material.",
    ].join("\n");
  const prompt = [
    instruction,
    `${zh ? "搜索词" : "Query"}: ${query}`,
    contextBlock,
    "",
    zh ? "结构化命中：" : "Structured hits:",
    structuredBullets || (zh ? "（无）" : "(none)"),
    "",
    zh ? "聚合正文摘录：" : "Aggregated excerpts:",
    extractedText.slice(0, AGGREGATE_PROMPT_MAX_CHARS),
  ].filter(Boolean).join("\n");
  try {
    const result = await Promise.race([
      Agent.prompt(prompt, {
        apiKey,
        model: { id: modelId },
        local: { cwd: process.cwd() },
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("summarize timeout")), SUMMARIZE_TIMEOUT_MS);
      }),
    ]);
    if (result.status === "error") {
      return undefined;
    }
    const text = result.result?.trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}
