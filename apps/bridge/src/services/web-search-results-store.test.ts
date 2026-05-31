import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadWebSearchRunResults,
  saveWebSearchRunResults,
  webSearchPersistedRunToContext,
} from "./web-search-results-store.js";


test("saveWebSearchRunResults 与 loadWebSearchRunResults 往返", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "websearch-cache-"));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });
  process.env.CHATTINGCURSOR_WEBSEARCH_CACHE_DIR = tempRoot;
  const runId = "run-test-001";
  await saveWebSearchRunResults({
    runId,
    query: "trump visit",
    userIntent: "请判断",
    fullPrompt: "请判断 /websearch trump",
    savedAt: new Date().toISOString(),
    serpItems: [{ title: "Headline", url: "https://news.example", snippet: "snippet" }],
    crawledPages: [{ title: "News", url: "https://news.example", text: "Body text." }],
    structuredBullets: "- Headline",
    aggregateExcerpt: "raw excerpt",
    pagesQueued: 1,
    pagesCrawled: 1,
    searchTimedOut: true,
  });
  const loaded = await loadWebSearchRunResults(runId);
  assert.ok(loaded);
  assert.equal(loaded?.query, "trump visit");
  assert.equal(loaded?.crawledPages.length, 1);
  assert.equal(loaded?.searchTimedOut, true);
  const context = webSearchPersistedRunToContext(loaded!);
  assert.equal(context.pagesCrawled, 1);
  assert.match(context.aggregateExcerpt, /raw excerpt/);
});
