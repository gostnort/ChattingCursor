import assert from "node:assert/strict";
import test from "node:test";
import { userMentionedThisProject, wrapCursorCliPrompt } from "./cli-conversation-guard.js";


test("未提及本项目时不改写字面量主体", () => {
  const prompt = "今天天气怎么样？";
  assert.equal(userMentionedThisProject(prompt), false);
  assert.equal(wrapCursorCliPrompt(prompt).endsWith(prompt), true);
  assert.match(wrapCursorCliPrompt(prompt), /系统约束/);
});


test("提到 ChattingCursor 时不加约束", () => {
  const prompt = "ChattingCursor 的 bridge 端口是多少？";
  assert.equal(userMentionedThisProject(prompt), true);
  assert.equal(wrapCursorCliPrompt(prompt), prompt);
});


test("提到本项目修改时不加约束", () => {
  const prompt = "总结一下本项目的最近修改";
  assert.equal(userMentionedThisProject(prompt), true);
  assert.equal(wrapCursorCliPrompt(prompt), prompt);
});
