import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitWebSearchRun,
  planWebSearchRun,
  resolveSerpStartOffsets,
} from "./websearch-state.js";


test("planWebSearchRun 两次同一查询推进 start 偏移", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "websearch-state-"));
  const statePath = path.join(dir, "websearch-state.json");
  t.after(async () => {
    process.env.CHATTINGCURSOR_WEBSEARCH_STATE_PATH = "";
    await rm(dir, { recursive: true, force: true });
  });
  process.env.CHATTINGCURSOR_WEBSEARCH_STATE_PATH = statePath;
  const query = "test query unique123";
  const first = await planWebSearchRun(query);
  assert.deepEqual(first.offsets, [10, 20]);
  assert.equal(first.isRepeat, false);
  await commitWebSearchRun(query, first.offsets, new Set(["https://example.com/a"]), new Set());
  const rawAfterFirst = JSON.parse(await readFile(statePath, "utf8")) as {
    queries: Record<string, { lastStartOffset: number }>;
  };
  const key = first.queryKey;
  assert.equal(rawAfterFirst.queries[key]?.lastStartOffset, 20);
  const second = await planWebSearchRun(query);
  assert.deepEqual(second.offsets, [30, 40, 50, 60, 70]);
  assert.equal(second.isRepeat, true);
  await commitWebSearchRun(
    query,
    second.offsets,
    new Set(["https://example.com/a", "https://example.com/b"]),
    new Set(),
  );
  const rawAfterSecond = JSON.parse(await readFile(statePath, "utf8")) as {
    queries: Record<string, { lastStartOffset: number; seenUrls: string[] }>;
  };
  assert.equal(rawAfterSecond.queries[key]?.lastStartOffset, 70);
  assert.equal(rawAfterSecond.queries[key]?.seenUrls.length, 2);
});

test("resolveSerpStartOffsets 与持久化 lastStartOffset 一致", () => {
  assert.deepEqual(resolveSerpStartOffsets(undefined).offsets, [10, 20]);
  assert.deepEqual(resolveSerpStartOffsets(20).offsets, [30, 40, 50, 60, 70]);
});
