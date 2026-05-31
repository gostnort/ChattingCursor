import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WebSearchSummarizeContext } from "./web-search-summarize.js";
import type { CrawledPageText, GoogleSerpItem } from "./google-serp-parse.js";
import { getWebSearchCacheDir } from "../paths.js";


export interface WebSearchPersistedRun {
  runId: string;
  query: string;
  userIntent?: string;
  fullPrompt?: string;
  savedAt: string;
  serpItems: GoogleSerpItem[];
  crawledPages: CrawledPageText[];
  structuredBullets: string;
  aggregateExcerpt: string;
  pagesQueued: number;
  pagesCrawled: number;
  searchTimedOut: boolean;
}


function resolveRunFilePath(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(getWebSearchCacheDir(), `${safe}.json`);
}


/** 将抓取阶段结果写入磁盘，供后续 LLM 综合读取 */
export async function saveWebSearchRunResults(payload: WebSearchPersistedRun): Promise<string> {
  const dir = getWebSearchCacheDir();
  await mkdir(dir, { recursive: true });
  const filePath = resolveRunFilePath(payload.runId);
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}


/** 从磁盘读取已持久化的抓取结果 */
export async function loadWebSearchRunResults(runId: string): Promise<WebSearchPersistedRun | null> {
  const filePath = resolveRunFilePath(runId);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as WebSearchPersistedRun;
    if (!parsed || typeof parsed !== "object" || parsed.runId !== runId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}


/** 将持久化记录转为综合阶段上下文 */
export function webSearchPersistedRunToContext(
  record: WebSearchPersistedRun,
): WebSearchSummarizeContext {
  return {
    query: record.query,
    userIntent: record.userIntent,
    fullPrompt: record.fullPrompt,
    aggregateExcerpt: record.aggregateExcerpt,
    structuredBullets: record.structuredBullets,
    pagesQueued: record.pagesQueued,
    pagesCrawled: record.pagesCrawled,
    crawledPages: record.crawledPages,
  };
}
