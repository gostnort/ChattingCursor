import type { CollectedChunk } from "./external-data-pipeline.js";
import {
  extractSearchKeywordCandidates,
  extractSearchKeywords,
  mergeHistorySearchHits,
  searchSessionMessages,
} from "./history-search-intent.js";
import type { HistoryStore } from "./history-store.js";


/** 将历史检索命中转为采集片段 */
function historyHitsToChunks(
  hits: Array<{ file: string; snippet: string; line?: number }>,
): CollectedChunk[] {
  return hits.map((hit) => ({
    source: "history",
    title: hit.file,
    text: hit.snippet,
    timestamp: hit.line !== undefined ? `line ${hit.line}` : undefined,
  }));
}


/** 采集当前会话 + 近 7 天磁盘历史（含 user 与 assistant） */
export async function collectHistoryData(
  sessionId: string,
  sessionMessages: Array<{ role: string; content: string }>,
  prompt: string,
  store: HistoryStore,
): Promise<{ chunks: CollectedChunk[]; query: string; userIntent: string }> {
  const query = extractSearchKeywords(prompt);
  const keywordCandidates = extractSearchKeywordCandidates(prompt);
  const sessionHits = searchSessionMessages(
    sessionMessages,
    keywordCandidates,
    sessionId,
    prompt,
  );
  const diskHits = await store.search(keywordCandidates);
  const hits = mergeHistorySearchHits(sessionHits, diskHits);
  return {
    chunks: historyHitsToChunks(hits),
    query,
    userIntent: prompt.trim(),
  };
}
