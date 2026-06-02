import assert from "node:assert/strict";
import test from "node:test";
import {
  isPromptDuplicatedInRecentHistory,
  RECENT_HISTORY_LIMIT,
  selectRecentHistory,
} from "./conversation-context.js";
import type { SessionMessage } from "./session-store.js";


const ts = "2026-01-01T00:00:00.000Z";


function msg(role: SessionMessage["role"], content: string): SessionMessage {
  return { role, content, timestamp: ts };
}


test("selectRecentHistory：仅保留 user/assistant 且非空，最多 20 条", () => {
  const history: SessionMessage[] = [];
  for (let i = 0; i < 25; i += 1) {
    history.push(msg(i % 2 === 0 ? "user" : "assistant", `m${i}`));
  }
  const recent = selectRecentHistory(history);
  assert.equal(recent.length, RECENT_HISTORY_LIMIT);
  assert.equal(recent[0]?.content, "m5");
  assert.equal(recent[recent.length - 1]?.content, "m24");
});


test("selectRecentHistory：过滤空内容消息", () => {
  const history = [msg("user", "a"), msg("user", "   "), msg("assistant", "b")];
  const recent = selectRecentHistory(history);
  assert.equal(recent.length, 2);
  assert.deepEqual(recent.map((m) => m.content), ["a", "b"]);
});


test("isPromptDuplicatedInRecentHistory：末尾用户消息与当前 prompt 相同", () => {
  const history = [msg("user", "hello"), msg("assistant", "hi")];
  assert.equal(isPromptDuplicatedInRecentHistory(history, "hello"), false);
  history.push(msg("user", "hello"));
  assert.equal(isPromptDuplicatedInRecentHistory(history, "hello"), true);
  assert.equal(isPromptDuplicatedInRecentHistory(history, "  hello  "), true);
});
