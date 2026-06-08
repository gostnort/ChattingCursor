/** 通过 Chrome 远程调试（默认 9222）在 Google 打开搜索页并摘录 SERP */

import { resolveBridgeChromeEndpoint } from "@chatting-cursor/shared/chrome-endpoint";
import {
  GOOGLE_PAGE_HTML_CAPTURE_EXPRESSION,
  GOOGLE_SERP_EXTRACT_EXPRESSION,
  buildStructuredSerpSummary,
  collectNewOrganicResultUrls,
  collectRandomNewOrganicResultUrls,
  preferChineseWebSearchReply,
  type CrawledPageText,
  type GoogleSerpItem,
  parseGoogleSerpEvaluateValue,
} from "./google-serp-parse.js";
import { extractReadabilityFromHtml, isLocalLlmModel } from "./local-llm-client.js";
import {
  ensureLocalLlmReady,
  ensureLocalLlmSidecarStarted,
} from "./local-llm-lifecycle.js";
import { resolveSessionWebSearchPassK } from "./web-search-intent.js";
import {
  commitWebSearchRun,
  hashWebSearchPageContent,
  maxLinksForWebSearchPass,
  planWebSearchRun,
  WEBSEARCH_LINKS_PER_SERP_PAGE,
  WEBSEARCH_PASS_DEADLINE_MS,
  type WebSearchRunPlan,
} from "./websearch-state.js";
import {
  persistWebSearchCrawlResults,
  runWebSearchPipeline,
  WEBSEARCH_SYNTHESIS_DEADLINE_MS,
} from "./web-search-summarize.js";

const NAVIGATE_TIMEOUT_MS = 15000;
const CDP_SESSION_TIMEOUT_MS = 180000;
const EXCERPT_MAX_CHARS = 8000;
const PAGE_TEXT_MAX_CHARS = 3500;
const AGGREGATE_EXCERPT_MAX_CHARS = 30000;
/** 结果页并发打开上限（每批打开后关闭再开下一批） */
export const WEBSEARCH_CRAWL_BATCH_SIZE = 5;
/** Bridge stdout 日志（英文，便于排查 /websearch） */
function logWebSearch(stage: string, details: Record<string, unknown>): void {
  console.info(`[websearch] ${stage}`, JSON.stringify(details));
}


export interface ChromeGoogleSearchOptions {
  /** 用户待回答的问题（行内背景、会话上文或搜索词） */
  userIntent?: string;
  /** 完整用户输入（用于判断回复语言） */
  fullPrompt?: string;
  /** 当前会话较早消息（用于 pass k 与意图） */
  sessionMessages?: { role: string; content: string }[];
  /** 会话所选模型（本地 LLM id 或 cursor CLI 模型名） */
  model?: string;
  workspace?: string;
  signal?: AbortSignal;
  /** Bridge runId，用于持久化抓取结果 */
  runId?: string;
}


/** 对外返回的检索元信息（不含 SERP/页面摘录） */
export interface WebSearchMeta {
  endpoint: string;
  searchUrl: string;
  pageUrl?: string;
  serpStartOffsets?: number[];
  /** 同会话内该查询第几次检索（k） */
  passK?: number;
  isRepeatSearch?: boolean;
  linksCrawled?: number;
  linksQueued?: number;
  linksTruncated?: boolean;
  crawlBatchCount?: number;
  crawlBatchSize?: number;
  serpPagesFetched?: number;
  statePath?: string;
  block?: "consent" | "captcha" | null;
  /** 是否在抓取阶段时限内提前结束 */
  timedOut?: boolean;
  /** 本次检索覆盖的 Google 页码范围（面向用户） */
  serpPageRange?: { minPage: number; maxPage: number };
  /** 抓取结果缓存文件路径 */
  resultsCachePath?: string;
}


export interface ChromeEndpointStatus {
  available: boolean;
  endpoint: string;
  pages?: number;
  message?: string;
}


export interface ChromeGoogleSearchResult {
  ok: boolean;
  /** 面向用户的综合回答（不含原始 SERP/摘录） */
  synthesis?: string;
  meta: WebSearchMeta;
  message?: string;
}


/** 构建 Google 搜索 URL（start 为分页偏移，0 表示第一页） */
export function buildGoogleSearchUrl(query: string, start = 0): string {
  const params = new URLSearchParams({ q: query });
  if (start > 0) {
    params.set("start", String(start));
  }
  return `https://www.google.com/search?${params.toString()}`;
}


/** 探测 Chrome 9222 是否可用 */
export async function inspectChromeEndpoint(): Promise<ChromeEndpointStatus> {
  const endpoint = resolveBridgeChromeEndpoint();
  try {
    const response = await fetch(`${endpoint}/json/list`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return {
        available: false,
        endpoint,
        message: `Chrome 9222 返回 HTTP ${response.status}`,
      };
    }
    const pages = await response.json() as unknown;
    if (!Array.isArray(pages)) {
      return {
        available: false,
        endpoint,
        message: "Chrome 9222 返回格式无效。",
      };
    }
    return {
      available: true,
      endpoint,
      pages: pages.length,
      message: "Chrome 9222 可用。",
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      endpoint,
      message: `无法连接 Chrome 9222：${detail}`,
    };
  }
}


interface PartialWebSearchBuildInput {
  query: string;
  options: ChromeGoogleSearchOptions;
  endpoint: string;
  searchUrl: string;
  plan: Awaited<ReturnType<typeof planWebSearchRun>>;
  runPlan: WebSearchRunPlan;
  serpCapture: CdpSerpCapture | null;
  serpOffsetsUsed: number[];
  serpItems: GoogleSerpItem[];
  crawledPages: CrawledPageText[];
  crawlQueue: string[];
  linksTruncated: boolean;
  crawlBatchCount: number;
  timedOut: boolean;
  modelReadyPromise?: Promise<void>;
}


/** 由已收集的 SERP / 页面摘录生成对外结果（含超时页脚） */
async function buildPartialWebSearchResult(
  input: PartialWebSearchBuildInput,
): Promise<ChromeGoogleSearchResult> {
  const {
    query,
    options,
    endpoint,
    searchUrl,
    plan,
    runPlan,
    serpCapture,
    serpOffsetsUsed,
    serpItems,
    crawledPages,
    crawlQueue,
    linksTruncated,
    crawlBatchCount,
    timedOut,
    modelReadyPromise,
  } = input;
  const structuredBullets = serpItems
    .map((item) => `- ${item.title}${item.snippet ? `: ${item.snippet.slice(0, 120)}` : ""}`)
    .join("\n");
  const pageBullets = crawledPages
    .map((page) => `- ${page.title} (${page.url}): ${page.text.slice(0, 240)}`)
    .join("\n");
  const aggregateExcerpt = crawledPages
    .map((page) => `## ${page.title}\n${page.url}\n${page.text}`)
    .join("\n\n")
    .slice(0, AGGREGATE_EXCERPT_MAX_CHARS);
  const blockSnapshot = {
    title: serpCapture?.title,
    url: serpCapture?.url && serpCapture.url !== "about:blank" ? serpCapture.url : searchUrl,
    text: serpCapture?.excerpt,
    items: serpItems,
    block: serpCapture?.block ?? null,
  };
  const blockNotice = serpCapture?.block
    ? buildStructuredSerpSummary(query, blockSnapshot)
    : undefined;
  let resultsCachePath: string | undefined;
  const summarizeContext = {
    query,
    userIntent: options.userIntent,
    fullPrompt: options.fullPrompt,
    aggregateExcerpt,
    structuredBullets: [structuredBullets, pageBullets].filter(Boolean).join("\n"),
    pagesQueued: crawlQueue.length,
    pagesCrawled: crawledPages.length,
    crawledPages,
  };
  if (!serpCapture?.block && options.runId && (crawledPages.length > 0 || serpItems.length > 0)) {
    try {
      resultsCachePath = await persistWebSearchCrawlResults(options.runId, summarizeContext, {
        searchTimedOut: timedOut,
        serpItems,
      });
      logWebSearch("crawl_results_persisted", {
        runId: options.runId,
        resultsCachePath,
        pagesCrawled: crawledPages.length,
        serpItemCount: serpItems.length,
        searchTimedOut: timedOut,
      });
    } catch (persistError: unknown) {
      const detail = persistError instanceof Error ? persistError.message : String(persistError);
      logWebSearch("crawl_results_persist_failed", { runId: options.runId, error: detail });
    }
  }
  const synthesisDeadlineMs = Date.now() + WEBSEARCH_SYNTHESIS_DEADLINE_MS;
  const crawlPass = runPlan.passes[0];
  const crawlBudgetMs = crawlPass?.deadlineMs ?? WEBSEARCH_PASS_DEADLINE_MS;
  const aiSummary = serpCapture?.block
    ? undefined
    : await runWebSearchPipeline(
      summarizeContext,
      {
        model: options.model,
        workspace: options.workspace,
        signal: options.signal,
        synthesisDeadlineMs,
        modelReadyPromise,
      },
    );
  let synthesis = blockNotice?.trim()
    || aiSummary?.trim()
    || undefined;
  if (timedOut) {
    synthesis = appendWebSearchTimeoutFooter(synthesis, query, crawlBudgetMs);
    logWebSearch("global_deadline_partial_reply", {
      serpItemCount: serpItems.length,
      linksCrawled: crawledPages.length,
      linksQueued: crawlQueue.length,
    });
  }
  const statusNotes: string[] = [];
  const crawlBudgetSec = Math.round(crawlBudgetMs / 1000);
  if (timedOut) {
    statusNotes.push(`检索在 ${crawlBudgetSec} 秒抓取时限内提前结束，已返回已收集资料的综合回答。`);
  }
  const pass = runPlan.passes[0];
  const pageLabel = pass ? `第 ${pass.minPage}–${pass.maxPage} 页` : "";
  if (plan.isRepeat) {
    statusNotes.push(`本次为同会话第 ${plan.passK} 次相同查询，已抓取 Google ${pageLabel}（start=${serpOffsetsUsed.join(",")}）。`);
  } else {
    statusNotes.push(`首次查询：已抓取 Google ${pageLabel}（start=${serpOffsetsUsed.join(",")}）。`);
  }
  const maxLinks = pass ? maxLinksForWebSearchPass(pass) : 0;
  if (linksTruncated) {
    statusNotes.push(
      `部分结果页未打开（单次合计 ${maxLinks} 条）。`,
    );
  }
  if (crawlQueue.length > 0) {
    statusNotes.push(
      `结果页分 ${crawlBatchCount} 批抓取（每批最多 ${WEBSEARCH_CRAWL_BATCH_SIZE} 个并发标签页）。`,
    );
  }
  statusNotes.push(`状态文件：${plan.statePath}`);
  const hasCollectedData = serpItems.length > 0 || crawledPages.length > 0 || Boolean(serpCapture?.block);
  const serpPageRange = runPlan.passes.length > 0
    ? {
      minPage: runPlan.passes[0].minPage,
      maxPage: runPlan.passes[runPlan.passes.length - 1].maxPage,
    }
    : undefined;
  return {
    ok: hasCollectedData || timedOut,
    synthesis,
    meta: {
      endpoint,
      searchUrl,
      pageUrl: serpCapture?.url,
      serpStartOffsets: serpOffsetsUsed,
      passK: plan.passK,
      isRepeatSearch: plan.isRepeat,
      linksCrawled: crawledPages.length,
      linksQueued: crawlQueue.length,
      linksTruncated,
      crawlBatchCount,
      crawlBatchSize: WEBSEARCH_CRAWL_BATCH_SIZE,
      serpPagesFetched: serpCapture?.pagesFetched,
      statePath: plan.statePath,
      block: serpCapture?.block,
      timedOut,
      serpPageRange,
      resultsCachePath,
    },
    message: statusNotes.join(" "),
  };
}


/** 在 Chrome 新标签页打开 Google 搜索，等待加载并摘录 SERP（两阶段抓取） */
export async function openGoogleSearchInChrome(
  query: string,
  options: ChromeGoogleSearchOptions = {},
): Promise<ChromeGoogleSearchResult> {
  const endpoint = resolveBridgeChromeEndpoint();
  const sessionPassK = resolveSessionWebSearchPassK(
    options.fullPrompt ?? query,
    options.sessionMessages ?? [],
  );
  const plan = await planWebSearchRun(query, sessionPassK);
  const { runPlan } = plan;
  const pass = runPlan.passes[0];
  if (!pass) {
    return {
      ok: false,
      meta: { endpoint, searchUrl: buildGoogleSearchUrl(query) },
      message: "无法规划检索阶段。",
    };
  }
  const allOffsets = pass.offsets;
  const firstOffset = allOffsets[0] ?? 0;
  const searchUrl = buildGoogleSearchUrl(query, firstOffset);
  let modelReadyPromise: Promise<void> | undefined;
  if (options.model && isLocalLlmModel(options.model)) {
    void ensureLocalLlmSidecarStarted(options.model).catch(() => undefined);
    modelReadyPromise = ensureLocalLlmReady(options.model).then(() => undefined);
  } else {
    void import("./local-llm-store.js").then(async ({ listInstalledLocalLlmModels }) => {
      const models = await listInstalledLocalLlmModels();
      const first = models.find((item) => item.weightsReady);
      if (first) {
        await ensureLocalLlmSidecarStarted(first.id);
      }
    }).catch(() => undefined);
  }
  logWebSearch("state_loaded", {
    query: query.trim(),
    queryKey: plan.queryKey,
    statePath: plan.statePath,
    isRepeat: plan.isRepeat,
    passK: plan.passK,
    serpStartOffsets: allOffsets,
    deadlineMs: pass.deadlineMs,
    seenUrlCount: plan.seenUrls.size,
  });
  const chrome = await inspectChromeEndpoint();
  if (!chrome.available) {
    return {
      ok: false,
      meta: { endpoint, searchUrl },
      message: chrome.message,
    };
  }
  const seenUrls = new Set(plan.seenUrls);
  const seenContentHashes = new Set(plan.seenContentHashes);
  const createdTabIds: string[] = [];
  let linksTruncated = false;
  let serpOffsetsUsed: number[] = [];
  let crawlQueue: string[] = [];
  let timedOut = false;
  let serpCapture: CdpSerpCapture | null = null;
  let crawledPages: CrawledPageText[] = [];
  let mergedSerpItems: GoogleSerpItem[] = [];
  let crawlBatchCount = 0;
  try {
    const created = await openTab(endpoint, "about:blank");
    const searchTargetId = typeof created.id === "string" ? created.id : "";
    if (searchTargetId) {
      createdTabIds.push(searchTargetId);
    }
    const wsUrl = await resolveTargetWebSocket(endpoint, searchTargetId);
    if (!wsUrl) {
      return {
        ok: false,
        meta: { endpoint, searchUrl },
        message: "已打开标签页，但无法获取 CDP WebSocket（无法导航或摘录）。",
      };
    }
    for (let passIndex = 0; passIndex < runPlan.passes.length; passIndex += 1) {
      const pass = runPlan.passes[passIndex];
      const passDeadline = Date.now() + pass.deadlineMs;
      if (isWebSearchDeadlineExceeded(passDeadline)) {
        timedOut = true;
        logWebSearch("pass_deadline_before_start", {
          pass: passIndex + 1,
          minPage: pass.minPage,
          maxPage: pass.maxPage,
        });
        break;
      }
      if (serpCapture?.block) {
        break;
      }
      logWebSearch("pass_start", {
        pass: passIndex + 1,
        offsets: pass.offsets,
        minPage: pass.minPage,
        maxPage: pass.maxPage,
        randomLinkSelection: pass.randomLinkSelection,
        deadlineMs: pass.deadlineMs,
      });
      const passSerpCapture = await captureGoogleSerpForOffsets(
        wsUrl,
        query,
        pass.offsets,
        passDeadline,
      );
      serpCapture = passSerpCapture;
      if (passSerpCapture.timedOut) {
        timedOut = true;
      }
      const passOffsetsUsed = pass.offsets.slice(
        0,
        passSerpCapture.pagesFetched ?? pass.offsets.length,
      );
      serpOffsetsUsed.push(...passOffsetsUsed);
      const passSerpItems = passSerpCapture.serpItems ?? [];
      mergedSerpItems = mergedSerpItems.concat(passSerpItems);
      logWebSearch("serp_captured", {
        pass: passIndex + 1,
        serpStartOffsets: passOffsetsUsed,
        serpItemCount: passSerpItems.length,
        block: passSerpCapture.block ?? null,
        timedOut: passSerpCapture.timedOut ?? false,
      });
      const passQueue: string[] = [];
      for (const pageItems of passSerpCapture.itemsByPage) {
        const collect = pass.randomLinkSelection
          ? collectRandomNewOrganicResultUrls
          : collectNewOrganicResultUrls;
        const batch = collect(pageItems, seenUrls, {
          perPageMax: WEBSEARCH_LINKS_PER_SERP_PAGE,
          totalMax: maxLinksForWebSearchPass(pass),
          alreadyQueued: crawlQueue.length + passQueue.length,
        });
        if (batch.truncated) {
          linksTruncated = true;
        }
        for (const href of batch.urls) {
          passQueue.push(href);
          seenUrls.add(href);
        }
      }
      crawlQueue.push(...passQueue);
      if (crawlQueue.length >= maxLinksForWebSearchPass(pass)) {
        linksTruncated = true;
      }
      logWebSearch("links_queued", {
        pass: passIndex + 1,
        passLinksQueued: passQueue.length,
        linksQueued: crawlQueue.length,
        linksTruncated,
      });
      if (passOffsetsUsed.length > 0) {
        await commitWebSearchRun(query, serpOffsetsUsed, seenUrls, seenContentHashes);
        logWebSearch("state_saved_after_serp", {
          pass: passIndex + 1,
          query: query.trim(),
          queryKey: plan.queryKey,
          lastStartOffset: Math.max(...serpOffsetsUsed),
          seenUrlCount: seenUrls.size,
        });
      }
      if (passSerpCapture.block) {
        break;
      }
      if (!isWebSearchDeadlineExceeded(passDeadline) && passQueue.length > 0) {
        const crawlOutcome = await crawlResultUrlsInBatches(
          endpoint,
          passQueue,
          seenContentHashes,
          WEBSEARCH_CRAWL_BATCH_SIZE,
          passDeadline,
        );
        crawledPages = crawledPages.concat(crawlOutcome.pages);
        crawlBatchCount += computeCrawlBatchCount(passQueue.length, WEBSEARCH_CRAWL_BATCH_SIZE);
        if (crawlOutcome.timedOut) {
          timedOut = true;
        }
      } else if (passQueue.length > 0 && isWebSearchDeadlineExceeded(passDeadline)) {
        timedOut = true;
        logWebSearch("pass_deadline_before_crawl", {
          pass: passIndex + 1,
          linksQueued: passQueue.length,
        });
      }
    }
    if (serpOffsetsUsed.length > 0 || crawledPages.length > 0) {
      await commitWebSearchRun(query, serpOffsetsUsed, seenUrls, seenContentHashes);
      logWebSearch("state_saved", {
        query: query.trim(),
        queryKey: plan.queryKey,
        lastStartOffset: serpOffsetsUsed.length > 0 ? Math.max(...serpOffsetsUsed) : 0,
        seenUrlCount: seenUrls.size,
        linksCrawled: crawledPages.length,
        timedOut,
      });
    }
    return buildPartialWebSearchResult({
      query,
      options,
      endpoint,
      searchUrl,
      plan,
      runPlan,
      serpCapture,
      serpOffsetsUsed,
      serpItems: mergedSerpItems,
      crawledPages,
      crawlQueue,
      linksTruncated,
      crawlBatchCount,
      timedOut,
      modelReadyPromise,
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    const deadlineHit = detail.includes("global deadline") || detail.includes("deadline exceeded");
    if (deadlineHit) {
      timedOut = true;
    }
    if (serpOffsetsUsed.length > 0) {
      try {
        await commitWebSearchRun(query, serpOffsetsUsed, seenUrls, seenContentHashes);
        logWebSearch("state_saved_partial", {
          query: query.trim(),
          serpStartOffsets: serpOffsetsUsed,
          seenUrlCount: seenUrls.size,
          error: detail,
        });
      } catch (commitError: unknown) {
        const commitDetail = commitError instanceof Error ? commitError.message : String(commitError);
        logWebSearch("state_save_failed", { error: commitDetail });
      }
    }
    const serpItems = mergedSerpItems.length > 0 ? mergedSerpItems : (serpCapture?.serpItems ?? []);
    if (deadlineHit || serpItems.length > 0 || crawledPages.length > 0) {
      return buildPartialWebSearchResult({
        query,
        options,
        endpoint,
        searchUrl,
        plan,
        runPlan,
        serpCapture,
        serpOffsetsUsed,
        serpItems,
        crawledPages,
        crawlQueue,
        linksTruncated,
        crawlBatchCount: crawlBatchCount || computeCrawlBatchCount(crawlQueue.length, WEBSEARCH_CRAWL_BATCH_SIZE),
        timedOut: timedOut || deadlineHit,
        modelReadyPromise,
      });
    }
    return {
      ok: false,
      meta: { endpoint, searchUrl, timedOut: deadlineHit || undefined },
      message: detail,
    };
  } finally {
    await closeCreatedTabs(endpoint, createdTabIds);
  }
}


/** 全局检索截止时刻是否已到 */
export function isWebSearchDeadlineExceeded(deadlineMs: number, nowMs = Date.now()): boolean {
  return nowMs >= deadlineMs;
}


/** 检索超时时的回复页脚（随查询语言中/英） */
export function buildWebSearchTimeoutFooter(
  query: string,
  crawlBudgetMs = WEBSEARCH_PASS_DEADLINE_MS,
): string {
  const crawlBudgetSec = Math.round(crawlBudgetMs / 1000);
  const zh = preferChineseWebSearchReply(query);
  return zh
    ? `（检索超时 ${crawlBudgetSec} 秒，以下为已收集资料的综合回答）`
    : `(Search timed out after ${crawlBudgetSec} seconds; answer synthesized from sources collected so far)`;
}


/** 在已有综合回答后追加超时页脚 */
export function appendWebSearchTimeoutFooter(
  synthesis: string | undefined,
  query: string,
  crawlBudgetMs = WEBSEARCH_PASS_DEADLINE_MS,
): string {
  const footer = buildWebSearchTimeoutFooter(query, crawlBudgetMs);
  if (!synthesis?.trim()) {
    return footer;
  }
  return `${synthesis.trim()}\n\n${footer}`;
}


/** 根据链接数计算批次数（12 链接、每批 5 → 3 批） */
export function computeCrawlBatchCount(urlCount: number, batchSize: number): number {
  if (urlCount <= 0 || batchSize <= 0) {
    return 0;
  }
  return Math.ceil(urlCount / batchSize);
}


/** 将 URL 列表按固定大小切分 */
function chunkUrls(urls: string[], batchSize: number): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < urls.length; index += batchSize) {
    batches.push(urls.slice(index, index + batchSize));
  }
  return batches;
}


interface CrawlBatchOutcome {
  pages: CrawledPageText[];
  timedOut: boolean;
}


/** 分批打开结果页：每批最多 batchSize 个标签，摘录后关闭再开下一批 */
async function crawlResultUrlsInBatches(
  endpoint: string,
  urls: string[],
  seenContentHashes: Set<string>,
  batchSize: number,
  globalDeadline: number,
  signal?: AbortSignal,
): Promise<CrawlBatchOutcome> {
  const crawledPages: CrawledPageText[] = [];
  const batches = chunkUrls(urls, batchSize);
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    if (isWebSearchDeadlineExceeded(globalDeadline)) {
      logWebSearch("global_deadline_before_batch", {
        batch: batchIndex + 1,
        totalBatches: batches.length,
        linksCrawled: crawledPages.length,
      });
      return { pages: crawledPages, timedOut: true };
    }
    const batchUrls = batches[batchIndex];
    const batchNumber = batchIndex + 1;
    console.info(
      `[websearch] Batch ${batchNumber}/${batches.length}: opened ${batchUrls.length} URLs...`,
    );
    logWebSearch("batch_start", {
      batch: batchNumber,
      totalBatches: batches.length,
      urlCount: batchUrls.length,
    });
    const opened: { targetUrl: string; pageTargetId: string }[] = [];
    for (const targetUrl of batchUrls) {
      if (isWebSearchDeadlineExceeded(globalDeadline)) {
        logWebSearch("global_deadline_before_tab", {
          batch: batchNumber,
          targetUrl,
          openedInBatch: opened.length,
        });
        await closeCreatedTabs(endpoint, opened.map((entry) => entry.pageTargetId));
        return { pages: crawledPages, timedOut: true };
      }
      try {
        const pageTab = await openTab(endpoint, targetUrl, globalDeadline);
        const pageTargetId = typeof pageTab.id === "string" ? pageTab.id : "";
        opened.push({ targetUrl, pageTargetId });
      } catch (openError: unknown) {
        const openDetail = openError instanceof Error ? openError.message : String(openError);
        if (openDetail.includes("global deadline")) {
          await closeCreatedTabs(endpoint, opened.map((entry) => entry.pageTargetId));
          return { pages: crawledPages, timedOut: true };
        }
        throw openError;
      }
    }
    const captures = await Promise.all(
      opened.map(async ({ targetUrl, pageTargetId }) => {
        if (!pageTargetId) {
          return null;
        }
        const pageWs = await resolveTargetWebSocket(endpoint, pageTargetId);
        if (!pageWs) {
          return null;
        }
        try {
          return await capturePageMainTextViaCdp(pageWs, targetUrl, signal);
        } catch {
          return null;
        }
      }),
    );
    const batchTabIds = opened
      .map((entry) => entry.pageTargetId)
      .filter((targetId): targetId is string => Boolean(targetId));
    const pagesBeforeBatch = crawledPages.length;
    for (let captureIndex = 0; captureIndex < captures.length; captureIndex += 1) {
      const pageText = captures[captureIndex];
      const targetUrl = batchUrls[captureIndex];
      if (!pageText) {
        continue;
      }
      const body = pageText.text.trim();
      if (!body) {
        continue;
      }
      const contentHash = hashWebSearchPageContent(body);
      if (seenContentHashes.has(contentHash)) {
        continue;
      }
      seenContentHashes.add(contentHash);
      crawledPages.push({
        title: pageText.title || targetUrl,
        url: pageText.url || targetUrl,
        text: body.slice(0, PAGE_TEXT_MAX_CHARS),
      });
    }
    logWebSearch("batch_done", {
      batch: batchNumber,
      totalBatches: batches.length,
      opened: batchUrls.length,
      extracted: crawledPages.length - pagesBeforeBatch,
    });
    await closeCreatedTabs(endpoint, batchTabIds);
  }
  return { pages: crawledPages, timedOut: false };
}


async function openTab(
  endpoint: string,
  url: string,
  globalDeadline?: number,
): Promise<Record<string, unknown>> {
  if (globalDeadline !== undefined && isWebSearchDeadlineExceeded(globalDeadline)) {
    throw new Error("websearch global deadline exceeded before opening tab");
  }
  const response = await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
    signal: AbortSignal.timeout(NAVIGATE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`打开新标签失败：HTTP ${response.status}`);
  }
  const payload = await response.json() as unknown;
  if (!payload || typeof payload !== "object") {
    throw new Error("打开新标签返回无效 JSON。");
  }
  return payload as Record<string, unknown>;
}


async function closeCreatedTabs(endpoint: string, targetIds: string[]): Promise<void> {
  for (const targetId of targetIds) {
    if (!targetId) {
      continue;
    }
    try {
      await fetch(`${endpoint}/json/close/${encodeURIComponent(targetId)}`, {
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // 忽略关闭失败，避免掩盖主流程错误
    }
  }
}


async function resolveTargetWebSocket(endpoint: string, targetId: string): Promise<string> {
  const deadline = Date.now() + NAVIGATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const target = await fetchTarget(endpoint, targetId);
    const wsUrl = typeof target?.webSocketDebuggerUrl === "string" ? target.webSocketDebuggerUrl : "";
    if (wsUrl) {
      return wsUrl;
    }
    await sleep(300);
  }
  return "";
}


async function fetchTarget(endpoint: string, targetId: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${endpoint}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    return null;
  }
  const pages = await response.json() as unknown;
  if (!Array.isArray(pages)) {
    return null;
  }
  for (const item of pages) {
    if (item && typeof item === "object" && (item as Record<string, unknown>).id === targetId) {
      return item as Record<string, unknown>;
    }
  }
  return null;
}


interface CdpSerpCapture {
  url?: string;
  title?: string;
  excerpt?: string;
  serpItems?: GoogleSerpItem[];
  itemsByPage: GoogleSerpItem[][];
  block?: "consent" | "captcha" | null;
  pagesFetched?: number;
  message?: string;
  timedOut?: boolean;
}


async function captureGoogleSerpForOffsets(
  webSocketDebuggerUrl: string,
  query: string,
  startOffsets: number[],
  globalDeadline: number,
): Promise<CdpSerpCapture> {
  return withCdpSession(webSocketDebuggerUrl, CDP_SESSION_TIMEOUT_MS, async (sendCommand) => {
    await sendCommand("Page.enable");
    await sendCommand("Runtime.enable");
    const mergedItems: GoogleSerpItem[] = [];
    const itemsByPage: GoogleSerpItem[][] = [];
    const seenTitles = new Set<string>();
    let lastSnapshot: ReturnType<typeof parseGoogleSerpEvaluateValue> | null = null;
    let pagesFetched = 0;
    let timedOut = false;
    for (const start of startOffsets) {
      if (isWebSearchDeadlineExceeded(globalDeadline)) {
        timedOut = true;
        logWebSearch("global_deadline_before_serp_page", {
          start,
          pagesFetched,
        });
        break;
      }
      if (lastSnapshot?.block) {
        break;
      }
      const pageUrl = buildGoogleSearchUrl(query, start);
      await sendCommand("Page.navigate", { url: pageUrl });
      await waitForGooglePageLoad(sendCommand, pageUrl);
      await waitForGoogleSerpResults(sendCommand);
      const extractResponse = await sendCommand("Runtime.evaluate", {
        expression: GOOGLE_SERP_EXTRACT_EXPRESSION,
        returnByValue: true,
      });
      const rawEvaluate = readEvaluateValue(extractResponse);
      const parsed = parseGoogleSerpEvaluateValue(rawEvaluate);
      const urlsOnPage = parsed.items.filter((item) => Boolean(item.url?.trim())).length;
      logWebSearch("serp_page_eval", {
        start,
        pageUrl,
        rawItemCount: parsed.items.length,
        urlsOnPage,
        block: parsed.block ?? null,
      });
      lastSnapshot = parsed;
      pagesFetched += 1;
      const pageItems: GoogleSerpItem[] = [];
      for (const item of parsed.items) {
        if (seenTitles.has(item.title)) {
          continue;
        }
        seenTitles.add(item.title);
        mergedItems.push(item);
        pageItems.push(item);
      }
      itemsByPage.push(pageItems);
      if (parsed.block) {
        break;
      }
    }
    return {
      url: lastSnapshot?.url,
      title: lastSnapshot?.title,
      excerpt: lastSnapshot?.text?.slice(0, EXCERPT_MAX_CHARS),
      serpItems: mergedItems,
      itemsByPage,
      block: lastSnapshot?.block ?? null,
      pagesFetched,
      timedOut,
    };
  });
}


interface PageTextCapture {
  title: string;
  url: string;
  text: string;
}


async function capturePageMainTextViaCdp(
  webSocketDebuggerUrl: string,
  targetUrl: string,
  signal?: AbortSignal,
): Promise<PageTextCapture> {
  return withCdpSession(webSocketDebuggerUrl, CDP_SESSION_TIMEOUT_MS, async (sendCommand) => {
    await sendCommand("Page.enable");
    await sendCommand("Runtime.enable");
    const current = await sendCommand("Runtime.evaluate", {
      expression: "({ url: location.href, ready: document.readyState })",
      returnByValue: true,
    });
    const currentValue = readEvaluateValue(current) as { url?: string; ready?: string } | undefined;
    const href = typeof currentValue?.url === "string" ? currentValue.url : "";
    const targetHost = (() => {
      try {
        return new URL(targetUrl).hostname;
      } catch {
        return "";
      }
    })();
    const onTarget = Boolean(targetHost && href.includes(targetHost));
    const needsNavigate = !href || href === "about:blank" || !href.startsWith("http") || !onTarget;
    if (needsNavigate) {
      await sendCommand("Page.navigate", { url: targetUrl });
    }
    await waitForGenericPageLoad(sendCommand, targetUrl);
    const extractResponse = await sendCommand("Runtime.evaluate", {
      expression: GOOGLE_PAGE_HTML_CAPTURE_EXPRESSION,
      returnByValue: true,
    });
    const value = readEvaluateValue(extractResponse) as Record<string, unknown> | undefined;
    const pageUrl = typeof value?.url === "string" ? value.url : targetUrl;
    const html = typeof value?.html === "string" ? value.html : "";
    const readability = await extractReadabilityFromHtml(pageUrl, html, signal);
    if (readability?.text.trim()) {
      return {
        title: readability.title || (typeof value?.title === "string" ? value.title : ""),
        url: pageUrl,
        text: readability.text,
      };
    }
    return {
      title: typeof value?.title === "string" ? value.title : "",
      url: pageUrl,
      text: "",
    };
  });
}


type SendCommand = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;


async function withCdpSession<T>(
  webSocketDebuggerUrl: string,
  timeoutMs: number,
  run: (sendCommand: SendCommand) => Promise<T>,
): Promise<T> {
  const WebSocketCtor = globalThis.WebSocket as (typeof WebSocket | undefined);
  if (!WebSocketCtor) {
    throw new Error("当前 Node 环境无 WebSocket，无法执行 CDP。");
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocketCtor(webSocketDebuggerUrl);
    let settled = false;
    let nextId = 1;
    const pending = new Map<number, { resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void }>();
    const finish = (result: T): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.close();
      } catch {
        // 忽略关闭错误
      }
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.close();
      } catch {
        // 忽略关闭错误
      }
      reject(error);
    };
    const sendCommand: SendCommand = (method, params) => {
      const id = nextId++;
      return new Promise((commandResolve, commandReject) => {
        pending.set(id, {
          resolve: commandResolve,
          reject: commandReject,
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    };
    const timer = setTimeout(() => {
      fail(new Error("CDP 会话超时"));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      void run(sendCommand)
        .then((result) => {
          clearTimeout(timer);
          finish(result);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          const detail = error instanceof Error ? error : new Error(String(error));
          fail(detail);
        });
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const id = typeof payload.id === "number" ? payload.id : 0;
      const waiter = pending.get(id);
      if (!waiter) {
        return;
      }
      pending.delete(id);
      if (payload.error && typeof payload.error === "object") {
        const message = typeof (payload.error as Record<string, unknown>).message === "string"
          ? (payload.error as Record<string, unknown>).message as string
          : "CDP error";
        waiter.reject(new Error(message));
        return;
      }
      waiter.resolve(payload);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      fail(new Error("CDP WebSocket 连接失败"));
    });
  });
}


function readEvaluateValue(response: Record<string, unknown>): unknown {
  const result = response.result as Record<string, unknown> | undefined;
  const inner = result?.result as Record<string, unknown> | undefined;
  return inner?.value;
}


async function waitForGoogleSerpResults(sendCommand: SendCommand): Promise<void> {
  const deadline = Date.now() + 20000;
  let skeletonWaits = 0;
  while (Date.now() < deadline) {
    const response = await sendCommand("Runtime.evaluate", {
      expression: `({
        titles: document.querySelectorAll(".MjjYud h3, .LC20lb, #search .g h3, div.g h3").length,
        blocks: document.querySelectorAll(".MjjYud").length
      })`,
      returnByValue: true,
    });
    const value = readEvaluateValue(response) as { titles?: number; blocks?: number } | undefined;
    const titles = typeof value?.titles === "number" ? value.titles : 0;
    const blocks = typeof value?.blocks === "number" ? value.blocks : 0;
    if (titles > 0) {
      await sleep(500);
      return;
    }
    if (blocks >= 3 && skeletonWaits < 4) {
      skeletonWaits += 1;
      await sleep(2000);
      continue;
    }
    await sleep(500);
  }
}


async function waitForGooglePageLoad(
  sendCommand: SendCommand,
  searchUrl: string,
): Promise<void> {
  const expectedHost = "google.";
  const deadline = Date.now() + NAVIGATE_TIMEOUT_MS;
  let sawComplete = false;
  while (Date.now() < deadline) {
    const response = await sendCommand("Runtime.evaluate", {
      expression: `({
        url: location.href,
        ready: document.readyState,
        resultCount: document.querySelectorAll(".MjjYud h3, .LC20lb, #search .g h3, div.g h3").length,
        blocked: /consent\\.google|Before you continue|unusual traffic|recaptcha/i.test(
          ((document.body && document.body.innerText) || "") + " " + location.href
        )
      })`,
      returnByValue: true,
    });
    const value = readEvaluateValue(response) as {
      url?: string;
      ready?: string;
      resultCount?: number;
      blocked?: boolean;
    } | undefined;
    const url = typeof value?.url === "string" ? value.url : "";
    const ready = typeof value?.ready === "string" ? value.ready : "";
    const resultCount = typeof value?.resultCount === "number" ? value.resultCount : 0;
    if (value?.blocked) {
      await sleep(400);
      return;
    }
    const onGoogle = url && url !== "about:blank" && url.includes(expectedHost);
    const pageReady = ready === "interactive" || ready === "complete";
    if (onGoogle && pageReady) {
      sawComplete = true;
      if (resultCount > 0) {
        await sleep(500);
        return;
      }
    }
    if (url.startsWith(searchUrl.split("?")[0] ?? "") && ready === "complete") {
      sawComplete = true;
    }
    await sleep(400);
  }
  if (sawComplete) {
    await sleep(1500);
  }
}


async function waitForGenericPageLoad(
  sendCommand: SendCommand,
  expectedUrl: string,
): Promise<void> {
  const deadline = Date.now() + NAVIGATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await sendCommand("Runtime.evaluate", {
      expression: "({ url: location.href, ready: document.readyState })",
      returnByValue: true,
    });
    const value = readEvaluateValue(response) as { url?: string; ready?: string } | undefined;
    const url = typeof value?.url === "string" ? value.url : "";
    const ready = typeof value?.ready === "string" ? value.ready : "";
    if (url && url !== "about:blank" && (ready === "interactive" || ready === "complete")) {
      if (!expectedUrl || url.startsWith("http")) {
        await sleep(500);
        return;
      }
    }
    await sleep(400);
  }
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
