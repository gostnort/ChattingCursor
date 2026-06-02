import {
  resolveWebSearchReplyLanguage,
} from "./google-serp-parse.js";
import type { CrawledPageText } from "./google-serp-parse.js";
import {
  WEBSEARCH_SYNTHESIS_DEADLINE_MS,
  buildSummarizeModelProvider,
  buildWebSearchSearchSummaryMessages,
  buildWebSearchSynthesisMessages,
  buildWebSearchSynthesisUnavailableMessage,
  ensureWebSearchSummarizeModelReady,
  formatCrawledPagesForSearchSummary,
  resolveSummarizeCallTimeoutMs,
  type WebSearchSummarizeContext,
  type WebSearchSummarizeMessage,
  type WebSearchSummarizeProvider,
} from "./web-search-summarize.js";

export { WEBSEARCH_SYNTHESIS_DEADLINE_MS } from "./web-search-summarize.js";

const AGGREGATE_PROMPT_MAX_CHARS = 30_000;
const PER_CHUNK_TEXT_MAX_CHARS = 4000;


/** 单条外部采集片段 */
export interface CollectedChunk {
  source: "web" | "history" | "knowledge" | string;
  title?: string;
  url?: string;
  text: string;
  timestamp?: string;
}


/** 统一外部资料综合上下文 */
export interface ExternalDataContext {
  chunks: CollectedChunk[];
  userIntent: string;
  query: string;
  fullPrompt?: string;
  /** 联网检索专用：结构化要点 */
  structuredBullets?: string;
  pagesQueued?: number;
  pagesCrawled?: number;
  crawledPages?: CrawledPageText[];
  sourceKind?: "web" | "history" | "knowledge" | "generic";
}


export type ExternalDataPipelineOptions = {
  model?: string;
  workspace?: string;
  signal?: AbortSignal;
  synthesisDeadlineMs?: number;
  provider?: WebSearchSummarizeProvider;
  skipModelReady?: boolean;
  modelReadyPromise?: Promise<void>;
};


function resolveZh(context: Pick<ExternalDataContext, "query" | "userIntent" | "fullPrompt">): boolean {
  return resolveWebSearchReplyLanguage(
    context.query,
    context.userIntent,
    context.fullPrompt,
  );
}


function isSynthesisDeadlineExceeded(deadlineMs: number | undefined, nowMs = Date.now()): boolean {
  return deadlineMs !== undefined && nowMs >= deadlineMs;
}


/** 将采集片段格式化为 LLM-1 材料文本 */
export function formatCollectedChunksToMaterial(
  chunks: CollectedChunk[],
  zh: boolean,
): string {
  if (chunks.length === 0) {
    return "";
  }
  return chunks
    .map((chunk) => {
      const body = chunk.text.slice(0, PER_CHUNK_TEXT_MAX_CHARS);
      const header = chunk.title?.trim() || chunk.source;
      const meta = [header, chunk.url, chunk.timestamp].filter(Boolean).join(" | ");
      if (zh) {
        return [`### ${meta}`, body || "（无正文）"].join("\n");
      }
      return [`### ${meta}`, body || "(empty)"].join("\n");
    })
    .join("\n\n");
}


/** 无命中时的明确提示 */
export function buildExternalDataNotFoundMessage(
  context: Pick<ExternalDataContext, "query" | "userIntent" | "fullPrompt" | "sourceKind">,
): string {
  const zh = resolveZh(context);
  const question = context.userIntent?.trim() || context.query.trim();
  if (context.sourceKind === "history") {
    return zh
      ? `在本地历史（近 7 天）及当前会话中未找到与「${question}」相关的内容。`
      : `No local history (last 7 days) or current session content matched "${question}".`;
  }
  if (context.sourceKind === "knowledge") {
    return zh
      ? `知识库中未找到与「${question}」相关的标签或条目内容。`
      : `No knowledge base entries matched "${question}".`;
  }
  return zh
    ? `未找到与「${question}」相关的资料。`
    : `No material found for "${question}".`;
}


/** 通用资料综合 system 提示（非联网页） */
export function buildExternalDataMaterialSummarySystemPrompt(zh: boolean): string {
  if (zh) {
    return [
      "你是资料整理助手。根据用户提供的多段摘录，写一份与主题相关的综合摘要。",
      "用中文、分段叙述，融合多来源；不要罗列原始索引式列表，不要照抄原文。",
      "若信息不足，说明不足并给出已有结论。",
    ].join("");
  }
  return [
    "You synthesize excerpts into one coherent summary for the given topic.",
    "Write prose; no bullet lists of raw hits. Note gaps briefly if needed.",
  ].join("");
}


/** 通用最终回答 system 提示 */
export function buildExternalDataFinalAnswerSystemPrompt(zh: boolean): string {
  if (zh) {
    return [
      "你是助手。根据用户问题与资料摘要，直接给出连贯回答。",
      "不要输出原始摘录列表或大量引用索引。",
      "若资料不足，明确说明未找到足够信息。",
    ].join("");
  }
  return [
    "Answer the user's question using the material summary provided.",
    "Do not dump raw excerpts. State clearly if information is insufficient.",
  ].join("");
}


function buildExternalDataMaterialSummaryUserPrompt(
  context: ExternalDataContext,
  material: string,
): string {
  const zh = resolveZh(context);
  const lines = [
    zh ? `主题：${context.query.trim()}` : `Topic: ${context.query.trim()}`,
    "",
    zh ? "资料摘录：" : "Excerpts:",
    material.slice(0, AGGREGATE_PROMPT_MAX_CHARS) || (zh ? "（无）" : "(none)"),
  ];
  return lines.join("\n");
}


function buildExternalDataFinalAnswerUserPrompt(
  context: ExternalDataContext,
  materialSummary: string,
): string {
  const zh = resolveZh(context);
  const question = context.userIntent?.trim() || context.query.trim();
  const lines = [
    zh ? `用户问题：${question}` : `User question: ${question}`,
    "",
    zh ? "资料摘要（仅供回答）：" : "Material summary (for your answer only):",
    materialSummary.slice(0, AGGREGATE_PROMPT_MAX_CHARS) || (zh ? "（无摘要）" : "(no summary)"),
  ];
  return lines.join("\n");
}


function buildExternalDataMaterialSummaryMessages(
  context: ExternalDataContext,
  material: string,
): WebSearchSummarizeMessage[] {
  const zh = resolveZh(context);
  return [
    { role: "system", content: buildExternalDataMaterialSummarySystemPrompt(zh) },
    { role: "user", content: buildExternalDataMaterialSummaryUserPrompt(context, material) },
  ];
}


function buildExternalDataFinalAnswerMessages(
  context: ExternalDataContext,
  materialSummary: string,
): WebSearchSummarizeMessage[] {
  const zh = resolveZh(context);
  return [
    { role: "system", content: buildExternalDataFinalAnswerSystemPrompt(zh) },
    { role: "user", content: buildExternalDataFinalAnswerUserPrompt(context, materialSummary) },
  ];
}


function toWebSearchContext(
  context: ExternalDataContext,
  material: string,
): WebSearchSummarizeContext {
  return {
    query: context.query,
    userIntent: context.userIntent,
    fullPrompt: context.fullPrompt,
    aggregateExcerpt: material,
    structuredBullets: context.structuredBullets ?? "",
    pagesQueued: context.pagesQueued ?? 0,
    pagesCrawled: context.pagesCrawled ?? 0,
    crawledPages: context.crawledPages,
  };
}


function resolvePipelineMaterial(context: ExternalDataContext): string {
  const pages = context.crawledPages ?? [];
  if (pages.length > 0 && context.sourceKind === "web") {
    const zh = resolveZh(context);
    const formatted = formatCrawledPagesForSearchSummary(context.query, pages, zh);
    if (formatted.trim()) {
      return formatted;
    }
  }
  if (context.chunks.length > 0) {
    const zh = resolveZh(context);
    return formatCollectedChunksToMaterial(context.chunks, zh);
  }
  return "";
}


async function raceProviderWithTimeout(
  provider: WebSearchSummarizeProvider,
  messages: WebSearchSummarizeMessage[],
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const text = await Promise.race([
      provider(messages),
      new Promise<undefined>((resolve) => {
        setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    const trimmed = text?.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}


async function summarizeMaterialWithProvider(
  context: ExternalDataContext,
  provider: WebSearchSummarizeProvider,
  material: string,
  timeoutMs: number,
): Promise<string | undefined> {
  if (!material.trim()) {
    return undefined;
  }
  const messages = context.sourceKind === "web"
    ? buildWebSearchSearchSummaryMessages(toWebSearchContext(context, material), material)
    : buildExternalDataMaterialSummaryMessages(context, material);
  return raceProviderWithTimeout(provider, messages, timeoutMs);
}


async function summarizeFinalAnswerWithProvider(
  context: ExternalDataContext,
  provider: WebSearchSummarizeProvider,
  materialSummary: string,
  timeoutMs: number,
): Promise<string | undefined> {
  if (!materialSummary.trim()) {
    return undefined;
  }
  const messages = context.sourceKind === "web"
    ? buildWebSearchSynthesisMessages(toWebSearchContext(context, materialSummary), materialSummary)
    : buildExternalDataFinalAnswerMessages(context, materialSummary);
  return raceProviderWithTimeout(provider, messages, timeoutMs);
}


/** LLM-1 材料摘要 + LLM-2 最终回答（历史/知识库/联网共用） */
export async function runExternalDataPipeline(
  context: ExternalDataContext,
  options: ExternalDataPipelineOptions = {},
): Promise<string | undefined> {
  const material = resolvePipelineMaterial(context);
  const hasBullets = Boolean(context.structuredBullets?.trim());
  const hasData = Boolean(material.trim()) || hasBullets;
  if (!hasData) {
    return buildExternalDataNotFoundMessage(context);
  }
  const synthesisDeadlineMs = options.synthesisDeadlineMs
    ?? Date.now() + WEBSEARCH_SYNTHESIS_DEADLINE_MS;
  if (options.modelReadyPromise) {
    await options.modelReadyPromise.catch(() => undefined);
  }
  if (!options.skipModelReady) {
    try {
      await ensureWebSearchSummarizeModelReady(options.model, options.signal);
    } catch {
      if (!material.trim()) {
        return buildExternalDataNotFoundMessage(context);
      }
    }
  }
  if (isSynthesisDeadlineExceeded(synthesisDeadlineMs)) {
    if (!material.trim()) {
      return buildExternalDataNotFoundMessage(context);
    }
    if (context.sourceKind === "web") {
      return buildWebSearchSynthesisUnavailableMessage(toWebSearchContext(context, material));
    }
    return buildExternalDataNotFoundMessage(context);
  }
  const provider = options.provider
    ?? buildSummarizeModelProvider(options.model, options.workspace, options.signal);
  const summarizeTimeoutMs = resolveSummarizeCallTimeoutMs(options.model, synthesisDeadlineMs);
  const effectiveMaterial = material.trim()
    ? material
    : (context.structuredBullets ?? "").trim();
  let materialSummary = effectiveMaterial
    ? await summarizeMaterialWithProvider(context, provider, effectiveMaterial, summarizeTimeoutMs)
    : undefined;
  if (!materialSummary?.trim()) {
    materialSummary = effectiveMaterial.slice(0, AGGREGATE_PROMPT_MAX_CHARS);
  }
  if (!materialSummary.trim()) {
    return buildExternalDataNotFoundMessage(context);
  }
  const finalTimeoutMs = resolveSummarizeCallTimeoutMs(options.model, synthesisDeadlineMs);
  const finalAnswer = await summarizeFinalAnswerWithProvider(
    context,
    provider,
    materialSummary,
    finalTimeoutMs,
  );
  if (finalAnswer) {
    return finalAnswer;
  }
  if (effectiveMaterial.trim() && effectiveMaterial !== materialSummary) {
    const fallback = await summarizeFinalAnswerWithProvider(
      context,
      provider,
      effectiveMaterial,
      resolveSummarizeCallTimeoutMs(options.model, synthesisDeadlineMs),
    );
    if (fallback) {
      return fallback;
    }
  }
  if (context.sourceKind === "web") {
    return buildWebSearchSynthesisUnavailableMessage(toWebSearchContext(context, effectiveMaterial));
  }
  return buildExternalDataNotFoundMessage(context);
}
