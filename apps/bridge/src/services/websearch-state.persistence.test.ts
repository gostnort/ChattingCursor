import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitWebSearchRun,
  planWebSearchRun,
  resolveWebSearchPassByK,
} from "./websearch-state.js";


test("planWebSearchRun 按 k 规划且持久化去重状态", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "websearch-state-"));
  const statePath = path.join(dir, "websearch-state.json");
  t.after(async () => {
    process.env.CHATTINGCURSOR_WEBSEARCH_STATE_PATH = "";
    await rm(dir, { recursive: true, force: true });
  });
  process.env.CHATTINGCURSOR_WEBSEARCH_STATE_PATH = statePath;
  const query = "test query unique123";
  const first = await planWebSearchRun(query, 1);
  assert.deepEqual(first.runPlan.passes[0].offsets, [0, 10, 20]);
  assert.equal(first.passK, 1);
  const firstOffsets = first.runPlan.passes[0].offsets;
  await commitWebSearchRun(query, firstOffsets, new Set(["https://example.com/a"]), new Set());
  const second = await planWebSearchRun(query, 2);
  assert.deepEqual(second.runPlan.passes[0].offsets, [30, 40, 50, 60, 70, 80, 90]);
  assert.equal(second.passK, 2);
  const rawAfterFirst = JSON.parse(await readFile(statePath, "utf8")) as {
    queries: Record<string, { lastStartOffset: number; seenUrls: string[] }>;
  };
  const key = first.queryKey;
  assert.equal(rawAfterFirst.queries[key]?.lastStartOffset, 20);
  const secondOffsets = second.runPlan.passes[0].offsets;
  await commitWebSearchRun(
    query,
    secondOffsets,
    new Set(["https://example.com/a", "https://example.com/b"]),
    new Set(),
  );
  const rawAfterSecond = JSON.parse(await readFile(statePath, "utf8")) as {
    queries: Record<string, { lastStartOffset: number; seenUrls: string[] }>;
  };
  assert.equal(rawAfterSecond.queries[key]?.lastStartOffset, 90);
  assert.equal(rawAfterSecond.queries[key]?.seenUrls.length, 2);
});


test("resolveWebSearchPassByK k=3 与 k=4 页范围", () => {
  assert.equal(resolveWebSearchPassByK(3).passes[0].minPage, 11);
  assert.equal(resolveWebSearchPassByK(4).passes[0].minPage, 16);
});
