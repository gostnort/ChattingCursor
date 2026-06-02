import assert from "node:assert/strict";
import test from "node:test";
import type { RunEvent } from "@chatting-cursor/shared";
import { extractAssistantText } from "./run-final-text.js";


const ts = "2026-06-01T00:00:00.000Z";


function event(type: RunEvent["type"], text?: string): RunEvent {
  return { runId: "run-1", type, timestamp: ts, text };
}


test("extractAssistantText 合并 assistant 增量", () => {
  const text = extractAssistantText([
    event("assistant", "Hello"),
    event("assistant", "Hello world"),
  ]);
  assert.equal(text, "Hello world");
});


test("extractAssistantText 优先 result 全文", () => {
  const text = extractAssistantText([
    event("assistant", "partial"),
    event("result", "final answer"),
  ]);
  assert.equal(text, "final answer");
});
