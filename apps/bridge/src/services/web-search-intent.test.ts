import assert from "node:assert/strict";
import test from "node:test";
import { extractWebSearchQuery, hasWebSearchIntent } from "./web-search-intent.js";


test("hasWebSearchIntent 识别 /websearch 与 /google（大小写不敏感）", () => {
  assert.equal(hasWebSearchIntent("/websearch 机票"), true);
  assert.equal(hasWebSearchIntent("/WEBSEARCH 机票"), true);
  assert.equal(hasWebSearchIntent("/google 机票"), true);
  assert.equal(hasWebSearchIntent("/Google 机票"), true);
});


test("hasWebSearchIntent 不把 /search 当作联网搜索", () => {
  assert.equal(hasWebSearchIntent("/search 旧对话"), false);
});


test("extractWebSearchQuery 从指令前缀提取关键词", () => {
  assert.equal(extractWebSearchQuery("/WEBSEARCH 下一趟CA988"), "下一趟CA988");
  assert.equal(extractWebSearchQuery("/google  测试  "), "测试");
});
