import { Agent } from "@cursor/sdk";
import { preferChineseWebSearchReply } from "./google-serp-parse.js";


const SUMMARIZE_TIMEOUT_MS = 90000;
const AGGREGATE_PROMPT_MAX_CHARS = 30000;


/** 若配置了 CURSOR_API_KEY，用 SDK 对聚合摘录做综合回答（失败则忽略） */
export async function maybeSummarizeWebSearchWithSdk(
  query: string,
  extractedText: string,
  structuredBullets: string,
  userIntent?: string,
): Promise<string | undefined> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey || !extractedText.trim()) {
    return undefined;
  }
  const modelId = process.env.CURSOR_WEB_SEARCH_MODEL?.trim() || "composer-2";
  const zh = preferChineseWebSearchReply(userIntent ?? "") || preferChineseWebSearchReply(query);
  const answerLanguage = zh ? "Chinese" : "English";
  const question = userIntent?.trim() || query.trim();
  const prompt = [
    `User question: ${question}`,
    `Search terms: ${query.trim()}`,
    `Based on the collected sources below, write a direct answer in ${answerLanguage}.`,
    "Do not list URLs unless essential. Do not output a bullet list of search hits or paste page excerpts.",
    "Write one coherent summary (综合回答) that answers the user's underlying question.",
    "",
    zh ? "结构化命中（仅供综合，勿照抄到回复）：" : "Structured hits (for synthesis only):",
    structuredBullets || (zh ? "（无）" : "(none)"),
    "",
    zh ? "聚合正文摘录（仅供综合）：" : "Aggregated excerpts (for synthesis only):",
    extractedText.slice(0, AGGREGATE_PROMPT_MAX_CHARS),
  ].join("\n");
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
