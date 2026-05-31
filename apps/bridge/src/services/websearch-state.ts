import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getWebSearchStatePath } from "../paths.js";

/** Google 分页步长 */
export const WEBSEARCH_SERP_OFFSET_STEP = 10;

/** 每个 SERP 页最多跟进的链接数 */
export const WEBSEARCH_LINKS_PER_SERP_PAGE = 3;

/** 常规单次抓取预算（毫秒） */
export const WEBSEARCH_PASS_DEADLINE_MS = 60_000;

/** 同会话第 2 次相同查询的抓取预算（毫秒） */
export const WEBSEARCH_REPEAT_PASS_DEADLINE_MS = 120_000;

/** @deprecated 使用 WEBSEARCH_PASS_DEADLINE_MS */
export const WEBSEARCH_FIRST_PASS_DEADLINE_MS = WEBSEARCH_PASS_DEADLINE_MS;

/** @deprecated 使用 WEBSEARCH_REPEAT_PASS_DEADLINE_MS */
export const WEBSEARCH_SECOND_PASS_DEADLINE_MS = WEBSEARCH_REPEAT_PASS_DEADLINE_MS;

/** @deprecated 单次仅一阶段 */
export const WEBSEARCH_FIRST_PASS_PAGE_COUNT = 3;

/** @deprecated 单次仅一阶段 */
export const WEBSEARCH_SECOND_PASS_PAGE_COUNT = 7;

/** @deprecated 使用 WEBSEARCH_LINKS_PER_SERP_PAGE */
export const WEBSEARCH_MAX_LINKS_PER_SERP_PAGE = WEBSEARCH_LINKS_PER_SERP_PAGE;


export interface WebSearchPassPlan {
  offsets: number[];
  /** 是否随机选取每页链接 */
  randomLinkSelection: boolean;
  deadlineMs: number;
  minPage: number;
  maxPage: number;
}


export interface WebSearchRunPlan {
  passes: WebSearchPassPlan[];
  /** 同会话内该查询第几次检索（k>=2 为重复） */
  isRepeat: boolean;
  /** 本次规划使用的 k（1-based） */
  passK: number;
}


export interface WebSearchQueryState {
  query: string;
  lastStartOffset: number;
  seenUrls: string[];
  seenContentHashes: string[];
}


interface WebSearchStateFile {
  queries: Record<string, WebSearchQueryState>;
}


function normalizeQueryForKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}


/** Google start 偏移换算为页码（start=0 → 第 1 页） */
export function googleStartOffsetToPageNumber(start: number): number {
  if (start <= 0) {
    return 1;
  }
  return Math.floor(start / WEBSEARCH_SERP_OFFSET_STEP) + 1;
}


/** 查询规范化后的 SHA256 前 16 位，用作状态键 */
export function webSearchQueryHash(query: string): string {
  const normalized = normalizeQueryForKey(query);
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}


/** 由 SERP 起始页与页数生成 start 偏移列表 */
function buildSerpOffsetsFromPageRange(startPage: number, pageCount: number): number[] {
  return Array.from(
    { length: pageCount },
    (_, index) => (startPage + index - 1) * WEBSEARCH_SERP_OFFSET_STEP,
  );
}


/**
 * 按会话内同查询出现次数 k（1-based）规划单次 /websearch 抓取。
 * k 仅来自当前会话较早用户消息，不使用持久化 lastStartOffset。
 */
export function resolveWebSearchPassByK(k: number): WebSearchRunPlan {
  const passK = Math.max(1, k);
  let startPage: number;
  let pageCount: number;
  let randomLinkSelection: boolean;
  let deadlineMs: number;
  if (passK === 1) {
    startPage = 1;
    pageCount = 3;
    randomLinkSelection = false;
    deadlineMs = WEBSEARCH_PASS_DEADLINE_MS;
  } else if (passK === 2) {
    startPage = 4;
    pageCount = 7;
    randomLinkSelection = true;
    deadlineMs = WEBSEARCH_REPEAT_PASS_DEADLINE_MS;
  } else {
    startPage = 11 + (passK - 3) * 5;
    pageCount = 5;
    randomLinkSelection = true;
    deadlineMs = WEBSEARCH_PASS_DEADLINE_MS;
  }
  const offsets = buildSerpOffsetsFromPageRange(startPage, pageCount);
  const minPage = startPage;
  const maxPage = startPage + pageCount - 1;
  return {
    passes: [
      {
        offsets,
        randomLinkSelection,
        deadlineMs,
        minPage,
        maxPage,
      },
    ],
    isRepeat: passK > 1,
    passK,
  };
}


/** @deprecated 使用 resolveWebSearchPassByK；保留供旧测试引用 */
export function resolveSerpStartOffsets(lastStartOffset: number | undefined): WebSearchRunPlan {
  if (lastStartOffset === undefined) {
    return resolveWebSearchPassByK(1);
  }
  const lastPage = googleStartOffsetToPageNumber(lastStartOffset);
  const startPage = lastPage + 1;
  const pageCount = 3;
  const offsets = buildSerpOffsetsFromPageRange(startPage, pageCount);
  return {
    passes: [
      {
        offsets,
        randomLinkSelection: true,
        deadlineMs: WEBSEARCH_PASS_DEADLINE_MS,
        minPage: startPage,
        maxPage: startPage + pageCount - 1,
      },
    ],
    isRepeat: true,
    passK: 0,
  };
}


/** 单次 pass 允许跟进的最多链接数 */
export function maxLinksForWebSearchPass(pass: WebSearchPassPlan): number {
  return WEBSEARCH_LINKS_PER_SERP_PAGE * pass.offsets.length;
}


/** 页面正文摘要哈希（去重近似重复内容） */
export function hashWebSearchPageContent(text: string): string {
  const sample = text.replace(/\s+/g, " ").trim().slice(0, 500);
  return createHash("sha256").update(sample, "utf8").digest("hex").slice(0, 16);
}


async function readStateFile(): Promise<WebSearchStateFile> {
  const filePath = getWebSearchStatePath();
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as WebSearchStateFile;
    if (!parsed || typeof parsed !== "object" || !parsed.queries) {
      return { queries: {} };
    }
    return parsed;
  } catch (error: unknown) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
    if (code === "ENOENT") {
      return { queries: {} };
    }
    throw error;
  }
}


async function writeStateFile(state: WebSearchStateFile): Promise<void> {
  const filePath = getWebSearchStatePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}


/** 读取某查询的持久化状态（无记录则 undefined） */
export async function loadWebSearchQueryState(query: string): Promise<WebSearchQueryState | undefined> {
  const state = await readStateFile();
  const key = webSearchQueryHash(query);
  const entry = state.queries[key];
  if (!entry) {
    return undefined;
  }
  return {
    ...entry,
    query: entry.query || query.trim(),
  };
}


/** 合并写入查询状态 */
export async function saveWebSearchQueryState(
  query: string,
  patch: Partial<WebSearchQueryState>,
): Promise<WebSearchQueryState> {
  const state = await readStateFile();
  const key = webSearchQueryHash(query);
  const previous = state.queries[key];
  const merged: WebSearchQueryState = {
    query: patch.query ?? previous?.query ?? query.trim(),
    lastStartOffset: patch.lastStartOffset ?? previous?.lastStartOffset ?? 0,
    seenUrls: patch.seenUrls ?? previous?.seenUrls ?? [],
    seenContentHashes: patch.seenContentHashes ?? previous?.seenContentHashes ?? [],
  };
  state.queries[key] = merged;
  await writeStateFile(state);
  return merged;
}


/** 规划本次 /websearch 的单阶段 SERP 偏移并带上已见 URL 集合 */
export async function planWebSearchRun(
  query: string,
  sessionPassK: number,
): Promise<{
  runPlan: WebSearchRunPlan;
  isRepeat: boolean;
  passK: number;
  seenUrls: Set<string>;
  seenContentHashes: Set<string>;
  statePath: string;
  queryKey: string;
}> {
  const trimmed = query.trim();
  const entry = await loadWebSearchQueryState(trimmed);
  const runPlan = resolveWebSearchPassByK(sessionPassK);
  const statePath = getWebSearchStatePath();
  const queryKey = webSearchQueryHash(trimmed);
  return {
    runPlan,
    isRepeat: runPlan.isRepeat,
    passK: runPlan.passK,
    seenUrls: new Set(entry?.seenUrls ?? []),
    seenContentHashes: new Set(entry?.seenContentHashes ?? []),
    statePath,
    queryKey,
  };
}


/** 搜索结束后持久化偏移、已见 URL 与内容哈希 */
export async function commitWebSearchRun(
  query: string,
  serpOffsetsUsed: number[],
  seenUrls: Set<string>,
  seenContentHashes: Set<string>,
): Promise<WebSearchQueryState> {
  const lastStartOffset = serpOffsetsUsed.length > 0
    ? Math.max(...serpOffsetsUsed)
    : 0;
  const saved = await saveWebSearchQueryState(query.trim(), {
    query: query.trim(),
    lastStartOffset,
    seenUrls: [...seenUrls],
    seenContentHashes: [...seenContentHashes],
  });
  console.info("[websearch] state saved", {
    statePath: getWebSearchStatePath(),
    queryKey: webSearchQueryHash(query),
    lastStartOffset: saved.lastStartOffset,
    seenUrlCount: saved.seenUrls.length,
    serpOffsetsUsed,
  });
  return saved;
}
