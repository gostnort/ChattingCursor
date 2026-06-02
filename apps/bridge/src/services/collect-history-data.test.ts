import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectHistoryData } from "./collect-history-data.js";
import { HistoryStore } from "./history-store.js";


test("collectHistoryData 包含当前会话 user 消息", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-history-collect-"));
  t.after(async () => {
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  const store = new HistoryStore(tempDir);
  await store.ensureDir();
  const sessionId = "sess-user-hit";
  await writeFile(
    path.join(tempDir, `${sessionId}.txt`),
    [
      "[2020-01-01] Session sess-user-hit",
      "[2020-01-02] User:",
      "我每天希望 500 大卡热量缺口。",
      "",
      "[2020-01-02] Assistant:",
      "好的。",
      "",
    ].join("\n"),
    "utf8",
  );
  const messages = [
    { role: "user", content: "你还记得我之前说过热量缺口吗？" },
    { role: "assistant", content: "让我查一下。" },
  ];
  const collected = await collectHistoryData(sessionId, messages, messages[0].content, store);
  assert.ok(collected.chunks.length >= 1);
  const combined = collected.chunks.map((chunk) => chunk.text).join("\n");
  assert.match(combined, /热量缺口/);
  assert.ok(
    collected.chunks.some((chunk) => chunk.text.includes("User:") || chunk.text.includes("500")),
  );
});
