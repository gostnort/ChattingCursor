import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getWebSearchStatePath } from "../paths.js";

/** 首次搜索：Google 第 2、3 页（start=10,20） */
export const WEBSEARCH_FIRST_RUN_OFFSETS = [10, 20] as const;

/** 重复同一查询时追加的 SERP 页数 */
export const WEBSEARCH_REPEAT_PAGE_COUNT = 5;

/** Google 分页步长 */
export const WEBSEARCH_SERP_OFFSET_STEP = 10;

/** 单次搜索最多抓取的结果页链接数 */
export const WEBSEARCH_MAX_LINKS_PER_SEARCH = 30;

/** 每个 SERP 批次最多跟进的链接数 */
export const WEBSEARCH_MAX_LINKS_PER_SERP_PAGE = 15;


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


/** 查询规范化后的 SHA256 前 16 位，用作状态键 */
export function webSearchQueryHash(query: string): string {
  const normalized = normalizeQueryForKey(query);
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}


/** 根据已处理的最大 start 偏移决定本次要抓取的 SERP 页 */
export function resolveSerpStartOffsets(lastStartOffset: number | undefined): {
  offsets: number[];
  isRepeat: boolean;
} {
  if (lastStartOffset === undefined) {
    return {
      offsets: [...WEBSEARCH_FIRST_RUN_OFFSETS],
      isRepeat: false,
    };
  }
  const offsets: number[] = [];
  for (let pageIndex = 1; pageIndex <= WEBSEARCH_REPEAT_PAGE_COUNT; pageIndex += 1) {
    offsets.push(lastStartOffset + pageIndex * WEBSEARCH_SERP_OFFSET_STEP);
  }
  return { offsets, isRepeat: true };
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


/** 规划本次 /websearch 的 SERP 偏移并带上已见 URL 集合 */
export async function planWebSearchRun(query: string): Promise<{
  offsets: number[];
  isRepeat: boolean;
  seenUrls: Set<string>;
  seenContentHashes: Set<string>;
  statePath: string;
  queryKey: string;
  previousLastStartOffset?: number;
}> {
  const trimmed = query.trim();
  const entry = await loadWebSearchQueryState(trimmed);
  const lastOffset = entry?.lastStartOffset;
  const hasPriorSerp = entry !== undefined && typeof lastOffset === "number" && lastOffset > 0;
  const resolved = resolveSerpStartOffsets(hasPriorSerp ? lastOffset : undefined);
  const statePath = getWebSearchStatePath();
  const queryKey = webSearchQueryHash(trimmed);
  return {
    offsets: resolved.offsets,
    isRepeat: resolved.isRepeat,
    seenUrls: new Set(entry?.seenUrls ?? []),
    seenContentHashes: new Set(entry?.seenContentHashes ?? []),
    statePath,
    queryKey,
    previousLastStartOffset: hasPriorSerp ? lastOffset : undefined,
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

