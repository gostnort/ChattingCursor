import { Agent } from "@cursor/sdk";


const SUMMARIZE_TIMEOUT_MS = 12000;


/** 若配置了 CURSOR_API_KEY，用 SDK 对摘录做短摘要（可选，失败则忽略） */
export async function maybeSummarizeWebSearchWithSdk(
  query: string,
  extractedText: string,
  structuredBullets: string,
): Promise<string | undefined> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey || !extractedText.trim()) {
    return undefined;
  }
  const modelId = process.env.CURSOR_WEB_SEARCH_MODEL?.trim() || "composer-2";
  const prompt = [
    "Summarize the following Google search page extract for the user.",
    `Search query: ${query}`,
    "Reply in the same language as the query (Chinese query → Chinese).",
    "Use 3-6 short bullet points; mention key facts only; no preamble.",
    "",
    "Structured hits:",
    structuredBullets || "(none)",
    "",
    "Raw page text:",
    extractedText.slice(0, 6000),
  ].join("\n");
  try {
    const agent = await Agent.create({
      apiKey,
      model: { id: modelId },
      local: { cwd: process.cwd() },
    });
    const run = await agent.send({ text: prompt });
    const result = await Promise.race([
      run.wait(),
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
