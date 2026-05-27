import assert from "node:assert/strict";
import test from "node:test";
import { hasHistorySearchIntent } from "./history-search-intent.js";
import { hasWebSearchIntent } from "./web-search-intent.js";


/** 与 chat.ts /chat/send 一致：仅普通对话需要 cursor-agent */
function chatSendNeedsCursorCli(prompt: string): boolean {
  return !hasHistorySearchIntent(prompt) && !hasWebSearchIntent(prompt);
}


test("/websearch 不要求 cursor-agent", () => {
  assert.equal(chatSendNeedsCursorCli("/websearch test"), false);
});


test("/search 本地历史不要求 cursor-agent", () => {
  assert.equal(chatSendNeedsCursorCli("/search 关键词"), false);
});


test("普通聊天需要 cursor-agent", () => {
  assert.equal(chatSendNeedsCursorCli("你好"), true);
});
