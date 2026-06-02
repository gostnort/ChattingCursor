import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HistoryStore } from "./history-store.js";


test("HistoryStore.search 支持多关键词 OR 匹配", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cc-history-"));
  try {
    const store = new HistoryStore(dir);
    await store.appendTurn("sess-1", "我每天希望 500 大卡热量缺口", "好的", "2026-06-01T00:00:00.000Z");
    const hits = await store.search(["热量缺口", "整句不存在"]);
    assert.equal(hits.length, 1);
    assert.match(hits[0].snippet, /热量缺口/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("HistoryStore.appendTurn 将会话写入 txt 文件", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cc-history-"));
  try {
    const store = new HistoryStore(dir);
    await store.appendTurn("sess-2", "用户问题", "助手回答", "2026-06-01T00:00:00.000Z");
    const content = await readFile(path.join(dir, "sess-2.txt"), "utf8");
    assert.match(content, /用户问题/);
    assert.match(content, /助手回答/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
