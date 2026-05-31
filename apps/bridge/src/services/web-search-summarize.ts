import { v4 as uuidv4 } from "uuid";
import { mergeAssistantStreamText, probeCursorCli, runCursorCli } from "@chatting-cursor/cli-client";
import { Agent } from "@cursor/sdk";
import {
  type CrawledPageText,
  resolveWebSearchReplyLanguage,
} from "./google-serp-parse.js";
import { completeLocalLlmChat, isLocalLlmModel } from "./local-llm-client.js";
import { ensureLocalLlmReady } from "./local-llm-lifecycle.js";
import { wrapCursorCliPrompt } from "./cli-conversation-guard.js";
import {
  loadWebSearchRunResults,
  saveWebSearchRunResults,
  webSearchPersistedRunToContext,
  type WebSearchPersistedRun,
} from "./web-search-results-store.js";

const SUMMARIZE_TIMEOUT_MS = 90_000;
/** 本地 LLM 综合默认超时（与 LOCAL_LLM_CHAT_TIMEOUT_MS 对齐） */
const LOCAL_LLM_SUMMARIZE_TIMEOUT_MS = 600_000;
/** 抓取阶段结束后，综合阶段单独预算（含本地模型加载） */
export const WEBSEARCH_SYNTHESIS_DEADLINE_MS = 600_000;
const AGGREGATE_PROMPT_MAX_CHARS = 30_000;
const PER_PAGE_TEXT_MAX_CHARS = 4000;

export interface WebSearchSummarizeContext {
  query: string;
  userIntent?: string;
  /** 完整用户输入（用于判断回复语言） */
  fullPrompt?: string;
  aggregateExcerpt: string;
  structuredBullets: string;
  pagesQueued: number;
  pagesCrawled: number;
  crawledPages?: CrawledPageText[];
}

export type WebSearchSummarizeMessage = {
  role: "system" | "user";
  content: string;
};

export type WebSearchSummarizeProvider = (
  messages: WebSearchSummarizeMessage[],
) => Promise<string | undefined>;

export interface WebSearchPageSummary {
  title: string;
  url: string;
  summary: string;
}

function resolveZh(context: Pick<WebSearchSummarizeContext, "query" | "userIntent" | "fullPrompt">): boolean {
  return resolveWebSearchReplyLanguage(
    context.query,
    context.userIntent,
    context.fullPrompt,
  );
}

/** 联网检索综合回答的系统提示（中/英） */
export function buildWebSearchSynthesisSystemPrompt(zh: boolean): string {
  if (zh) {
    return [
      "你是联网检索助手。根据用户提供的网页检索摘录，直接回答用户问题。",
      "用中文写一段连贯的综合总结，不要罗列大量链接，不要输出搜索结果索引式短引用列表。",
      "不要照抄摘录原文；可融合多来源信息。若信息不足，说明不足并给出已有结论。",
      "若部分页面未能抓取，在回答末尾简短说明，不要只输出失败信息。",
    ].join("");
  }
  return [
    "You synthesize answers from web search excerpts provided by the user.",
    "Write one coherent summary that directly answers the user's question.",
    "Do not dump URLs or bullet lists of search hits. Do not paste raw excerpts.",
    "If sources are incomplete, say so briefly at the end.",
  ].join(" ");
}

/** 检索材料综合为「搜索摘要」的系统提示（LLM-1，中/英） */
export function buildWebSearchSearchSummarySystemPrompt(zh: boolean): string {
  if (zh) {
    return [
      "你是联网检索助手。根据用户提供的多篇网页正文摘录，写一份与搜索主题相关的综合摘要。",
      "用中文、分段叙述，融合多来源信息；不要罗列 URL，不要输出搜索结果索引式列表。",
      "若部分页面无正文，在末尾简短说明。",
    ].join("");
  }
  return [
    "You synthesize web page excerpts into one search summary for the given topic.",
    "Write coherent prose; no URL dumps or bullet lists of links.",
    "Note briefly if some pages lacked body text.",
  ].join(" ");
}

/** 将已抓取页面格式化为 LLM-1 输入材料 */
export function formatCrawledPagesForSearchSummary(
  _query: string,
  pages: CrawledPageText[],
  zh: boolean,
): string {
  if (pages.length === 0) {
    return "";
  }
  return pages
    .map((page) => {
      const body = page.text.slice(0, PER_PAGE_TEXT_MAX_CHARS);
      if (zh) {
        return [
          `### ${page.title}`,
          page.url,
          body || "（未能抓取正文）",
        ].join("\n");
      }
      return [
        `### ${page.title}`,
        page.url,
        body || "(no body text captured)",
      ].join("\n");
    })
    .join("\n\n");
}


/** 构建 LLM-1（搜索摘要）user 消息 */
export function buildWebSearchSearchSummaryUserPrompt(
  context: Pick<WebSearchSummarizeContext, "query" | "userIntent" | "fullPrompt" | "pagesQueued" | "pagesCrawled">,
  material: string,
): string {
  const zh = resolveZh(context);
  const fetchGap = Math.max(0, context.pagesQueued - context.pagesCrawled);
  const lines = [
    zh ? `搜索主题：${context.query.trim()}` : `Search topic: ${context.query.trim()}`,
  ];
  if (fetchGap > 0) {
    lines.push(
      zh
        ? `（${fetchGap} 个排队结果页未能抓取正文，请基于已抓取内容摘要。）`
        : `(${fetchGap} queued page(s) could not be fetched; summarize from captured pages.)`,
    );
  }
  lines.push(
    "",
    zh ? "网页正文摘录：" : "Page excerpts:",
    material.slice(0, AGGREGATE_PROMPT_MAX_CHARS) || (zh ? "（无）" : "(none)"),
  );
  return lines.join("\n");
}

/** 构建 LLM-2（最终回答）user 消息：用户意图 + 搜索摘要 */
export function buildWebSearchSynthesisUserPrompt(
  context: Pick<WebSearchSummarizeContext, "query" | "userIntent" | "fullPrompt" | "pagesQueued" | "pagesCrawled">,
  searchSummary: string,
): string {
  const zh = resolveZh(context);
  const question = context.userIntent?.trim() || context.query.trim();
  const fetchGap = Math.max(0, context.pagesQueued - context.pagesCrawled);
  const lines = [
    zh ? `用户问题：${question}` : `User question: ${question}`,
    zh ? `搜索词：${context.query.trim()}` : `Search terms: ${context.query.trim()}`,
  ];
  if (fetchGap > 0) {
    lines.push(
      zh
        ? `（${fetchGap} 个排队结果页未能抓取正文，请基于已有搜索摘要回答。）`
        : `(${fetchGap} queued page(s) could not be fetched; answer from the search summary.)`,
    );
  }
  lines.push(
    "",
    zh ? "搜索摘要（仅供回答，勿照抄链接列表）：" : "Search summary (for your answer only):",
    searchSummary.slice(0, AGGREGATE_PROMPT_MAX_CHARS) || (zh ? "（无摘要）" : "(no summary)"),
  );
  return lines.join("\n");
}

/** 构建 LLM-2 system + user 消息对 */
export function buildWebSearchSynthesisMessages(
  context: WebSearchSummarizeContext,
  searchSummary: string,
): WebSearchSummarizeMessage[] {
  const zh = resolveZh(context);
  return [
    { role: "system", content: buildWebSearchSynthesisSystemPrompt(zh) },
    { role: "user", content: buildWebSearchSynthesisUserPrompt(context, searchSummary) },
  ];
}


/** 构建 LLM-1 system + user 消息对 */
export function buildWebSearchSearchSummaryMessages(
  context: WebSearchSummarizeContext,
  material: string,
): WebSearchSummarizeMessage[] {
  const zh = resolveZh(context);
  return [
    { role: "system", content: buildWebSearchSearchSummarySystemPrompt(zh) },
    { role: "user", content: buildWebSearchSearchSummaryUserPrompt(context, material) },
  ];
}

/** LLM 综合失败时面向用户的提示（非原始 SERP 列表） */
export function buildWebSearchSynthesisUnavailableMessage(
  context: Pick<WebSearchSummarizeContext, "query" | "userIntent" | "fullPrompt">,
): string {
  const zh = resolveZh(context);
  if (zh) {
    return [
      "未能用当前所选模型将检索结果整理成回答。",
      "请确认：本地模型已完成加载，或已安装可用的 Cursor Agent CLI，或已设置 CURSOR_API_KEY。",
      "然后重新发送 /websearch 指令。",
    ].join("");
  }
  return [
    "Could not synthesize an answer with the selected model.",
    "Ensure the local LLM is loaded, Cursor Agent CLI is available, or CURSOR_API_KEY is set, then retry /websearch.",
  ].join(" ");
}

/** 将各页摘要格式化为最终综合阶段的 aggregateExcerpt */
export function formatPageSummariesForAggregate(summaries: WebSearchPageSummary[]): string {
  if (summaries.length === 0) {
    return "";
  }
  return summaries
    .map((entry) => `### ${entry.title}\n${entry.url}\n${entry.summary}`)
    .join("\n\n");
}

/** 联网综合单次 LLM 调用的超时（本地模型需数分钟，Cursor/SDK 保持 90s） */
export function resolveWebSearchSummarizeTimeoutMs(model?: string): number {
  if (model && isLocalLlmModel(model)) {
    const raw = process.env.WEBSEARCH_LOCAL_SYNTHESIS_TIMEOUT_MS?.trim()
      ?? process.env.LOCAL_LLM_CHAT_TIMEOUT_MS?.trim()
      ?? process.env.GEMMA4_CHAT_TIMEOUT_MS?.trim()
      ?? "";
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return LOCAL_LLM_SUMMARIZE_TIMEOUT_MS;
  }
  return SUMMARIZE_TIMEOUT_MS;
}


function resolveSummarizeCallTimeoutMs(
  model: string | undefined,
  synthesisDeadlineMs: number | undefined,
): number {
  const preferred = resolveWebSearchSummarizeTimeoutMs(model);
  if (synthesisDeadlineMs === undefined) {
    return preferred;
  }
  const remaining = synthesisDeadlineMs - Date.now();
  if (remaining <= 0) {
    return SUMMARIZE_TIMEOUT_MS;
  }
  return Math.min(preferred, remaining);
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


/** 用注入的 provider 做 LLM-2 最终回答（测试用） */
export async function summarizeWebSearchWithProvider(
  context: WebSearchSummarizeContext,
  provider: WebSearchSummarizeProvider,
  searchSummary: string,
  timeoutMs = SUMMARIZE_TIMEOUT_MS,
): Promise<string | undefined> {
  if (!searchSummary.trim()) {
    return undefined;
  }
  const messages = buildWebSearchSynthesisMessages(context, searchSummary);
  return raceProviderWithTimeout(provider, messages, timeoutMs);
}


/** 用注入的 provider 做 LLM-1 搜索摘要（测试用） */
export async function summarizeWebSearchMaterialWithProvider(
  context: WebSearchSummarizeContext,
  provider: WebSearchSummarizeProvider,
  material: string,
  timeoutMs = SUMMARIZE_TIMEOUT_MS,
): Promise<string | undefined> {
  if (!material.trim()) {
    return undefined;
  }
  const messages = buildWebSearchSearchSummaryMessages(context, material);
  return raceProviderWithTimeout(provider, messages, timeoutMs);
}

async function summarizeWithCursorCli(
  messages: WebSearchSummarizeMessage[],
  model: string | undefined,
  workspace: string | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const cli = await probeCursorCli();
  if (!cli.available) {
    return undefined;
  }
  if (signal?.aborted) {
    return undefined;
  }
  const prompt = messages.map((message) => {
    if (message.role === "system") {
      return `[System]\n${message.content}`;
    }
    return message.content;
  }).join("\n\n");
  const runId = uuidv4();
  let assistantText = "";
  if (signal?.aborted) {
    return undefined;
  }
  await runCursorCli({
    runId,
    prompt: wrapCursorCliPrompt(prompt),
    model,
    workspace,
    timeoutMs: SUMMARIZE_TIMEOUT_MS,
    onEvent: (event) => {
      if (event.type === "assistant" && event.text) {
        assistantText = mergeAssistantStreamText(assistantText, event.text);
      }
      if (event.type === "result" && event.text) {
        assistantText = event.text;
      }
    },
  });
  if (signal?.aborted) {
    return undefined;
  }
  const trimmed = assistantText.trim();
  return trimmed || undefined;
}

async function summarizeWithLocalLlm(
  messages: WebSearchSummarizeMessage[],
  modelId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const text = await completeLocalLlmChat(modelId, messages, signal);
    return text.trim() || undefined;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[websearch] local LLM synthesis failed (${modelId}): ${detail}`);
    return undefined;
  }
}

async function summarizeWithSdk(
  messages: WebSearchSummarizeMessage[],
): Promise<string | undefined> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }
  const modelId = process.env.CURSOR_WEB_SEARCH_MODEL?.trim() || "composer-2";
  const prompt = messages.map((message) => {
    if (message.role === "system") {
      return `[System]\n${message.content}`;
    }
    return message.content;
  }).join("\n\n");
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

/** 综合阶段开始前确保本地模型 sidecar 与 GGUF 已就绪 */
export async function ensureWebSearchSummarizeModelReady(
  model: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!model || !isLocalLlmModel(model)) {
    return;
  }
  if (signal?.aborted) {
    return;
  }
  await ensureLocalLlmReady(model);
}


function buildActiveModelProvider(
  model: string | undefined,
  workspace: string | undefined,
  signal?: AbortSignal,
): WebSearchSummarizeProvider {
  const tryLocal = model && isLocalLlmModel(model);
  return async (messages) => {
    if (tryLocal && model) {
      const local = await summarizeWithLocalLlm(messages, model, signal);
      if (local) {
        return local;
      }
    }
    const cli = await summarizeWithCursorCli(messages, model, workspace, signal);
    if (cli) {
      return cli;
    }
    return summarizeWithSdk(messages);
  };
}

/** 用会话所选模型生成搜索摘要或最终回答 */
export async function summarizeWebSearchWithActiveModel(
  context: WebSearchSummarizeContext,
  options: {
    model?: string;
    workspace?: string;
    signal?: AbortSignal;
    searchSummary?: string;
    material?: string;
    phase?: "search_summary" | "final_answer";
  } = {},
): Promise<string | undefined> {
  const { model, workspace, signal } = options;
  const provider = buildActiveModelProvider(model, workspace, signal);
  const timeoutMs = resolveWebSearchSummarizeTimeoutMs(model);
  if (options.phase === "search_summary") {
    return summarizeWebSearchMaterialWithProvider(
      context,
      provider,
      options.material ?? context.aggregateExcerpt,
      timeoutMs,
    );
  }
  return summarizeWebSearchWithProvider(
    context,
    provider,
    options.searchSummary ?? context.aggregateExcerpt,
    timeoutMs,
  );
}

function isSynthesisDeadlineExceeded(deadlineMs: number | undefined, nowMs = Date.now()): boolean {
  return deadlineMs !== undefined && nowMs >= deadlineMs;
}


function resolveSearchSummaryMaterial(context: WebSearchSummarizeContext): string {
  const pages = context.crawledPages ?? [];
  if (pages.length > 0) {
    const zh = resolveZh(context);
    const formatted = formatCrawledPagesForSearchSummary(context.query, pages, zh);
    if (formatted.trim()) {
      return formatted;
    }
  }
  return context.aggregateExcerpt.trim();
}

/** 持久化抓取结果并返回文件路径 */
export async function persistWebSearchCrawlResults(
  runId: string,
  context: WebSearchSummarizeContext,
  options: {
    searchTimedOut?: boolean;
    serpItems?: WebSearchPersistedRun["serpItems"];
  } = {},
): Promise<string> {
  return saveWebSearchRunResults({
    runId,
    query: context.query,
    userIntent: context.userIntent,
    fullPrompt: context.fullPrompt,
    savedAt: new Date().toISOString(),
    serpItems: options.serpItems ?? [],
    crawledPages: context.crawledPages ?? [],
    structuredBullets: context.structuredBullets,
    aggregateExcerpt: context.aggregateExcerpt,
    pagesQueued: context.pagesQueued,
    pagesCrawled: context.pagesCrawled,
    searchTimedOut: options.searchTimedOut ?? false,
  });
}


/** 从持久化记录运行综合阶段（Phase B–D） */
export async function runWebSearchSynthesisFromPersisted(
  runId: string,
  options: {
    model?: string;
    workspace?: string;
    signal?: AbortSignal;
    synthesisDeadlineMs?: number;
    provider?: WebSearchSummarizeProvider;
  } = {},
): Promise<string | undefined> {
  const record = await loadWebSearchRunResults(runId);
  if (!record) {
    return undefined;
  }
  return runWebSearchPipeline(webSearchPersistedRunToContext(record), options);
}


/** LLM-1 搜索摘要 + LLM-2 最终回答（无逐页 LLM） */
export async function runWebSearchPipeline(
  context: WebSearchSummarizeContext,
  options: {
    model?: string;
    workspace?: string;
    signal?: AbortSignal;
    /** @deprecated 使用 synthesisDeadlineMs */
    deadlineMs?: number;
    synthesisDeadlineMs?: number;
    /** 测试注入 */
    provider?: WebSearchSummarizeProvider;
    /** 测试注入：跳过 ensureLocalLlmReady */
    skipModelReady?: boolean;
    /** 测试注入：模型已在抓取阶段并行加载 */
    modelReadyPromise?: Promise<void>;
  } = {},
): Promise<string | undefined> {
  const synthesisDeadlineMs = options.synthesisDeadlineMs
    ?? (options.deadlineMs !== undefined
      ? options.deadlineMs
      : Date.now() + WEBSEARCH_SYNTHESIS_DEADLINE_MS);
  const material = resolveSearchSummaryMaterial(context);
  const hasData = Boolean(material.trim()) || Boolean(context.structuredBullets.trim());
  if (!hasData) {
    return undefined;
  }
  if (options.modelReadyPromise) {
    await options.modelReadyPromise.catch(() => undefined);
  }
  if (!options.skipModelReady) {
    try {
      await ensureWebSearchSummarizeModelReady(options.model, options.signal);
    } catch {
      if (!material.trim()) {
        return undefined;
      }
    }
  }
  if (isSynthesisDeadlineExceeded(synthesisDeadlineMs)) {
    if (!material.trim()) {
      return undefined;
    }
    return buildWebSearchSynthesisUnavailableMessage(context);
  }
  const provider = options.provider
    ?? buildActiveModelProvider(options.model, options.workspace, options.signal);
  const summarizeTimeoutMs = resolveSummarizeCallTimeoutMs(options.model, synthesisDeadlineMs);
  let searchSummary = material
    ? await summarizeWebSearchMaterialWithProvider(context, provider, material, summarizeTimeoutMs)
    : undefined;
  if (!searchSummary?.trim()) {
    searchSummary = material.slice(0, AGGREGATE_PROMPT_MAX_CHARS);
  }
  if (!searchSummary.trim()) {
    return buildWebSearchSynthesisUnavailableMessage(context);
  }
  const finalTimeoutMs = resolveSummarizeCallTimeoutMs(options.model, synthesisDeadlineMs);
  const finalAnswer = await summarizeWebSearchWithProvider(context, provider, searchSummary, finalTimeoutMs);
  if (finalAnswer) {
    return finalAnswer;
  }
  if (material.trim() && material !== searchSummary) {
    const fallbackTimeoutMs = resolveSummarizeCallTimeoutMs(options.model, synthesisDeadlineMs);
    const fallback = await summarizeWebSearchWithProvider(context, provider, material, fallbackTimeoutMs);
    if (fallback) {
      return fallback;
    }
  }
  return buildWebSearchSynthesisUnavailableMessage(context);
}

/** @deprecated 仅 SDK；请用 summarizeWebSearchWithActiveModel */
export async function maybeSummarizeWebSearchWithSdk(
  query: string,
  extractedText: string,
  structuredBullets: string,
  userIntent?: string,
): Promise<string | undefined> {
  return runWebSearchPipeline(
    {
      query,
      userIntent,
      aggregateExcerpt: extractedText,
      structuredBullets,
      pagesQueued: 0,
      pagesCrawled: 0,
    },
    { skipModelReady: true },
  );
}

