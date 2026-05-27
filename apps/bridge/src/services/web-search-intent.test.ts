import assert from "node:assert/strict";
import test from "node:test";
import { extractWebSearchQuery, formatWebSearchReply, hasWebSearchIntent } from "./web-search-intent.js";


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


test("formatWebSearchReply 含搜索摘要与来源", () => {
  const reply = formatWebSearchReply("机票", {
    ok: true,
    endpoint: "http://127.0.0.1:9222",
    searchUrl: "https://www.google.com/search?q=%E6%9C%BA%E7%A5%A8",
    pageUrl: "https://www.google.com/search?q=%E6%9C%BA%E7%A5%A8",
    serpItems: [{ title: "航班动态", url: "https://example.com", snippet: "CA988" }],
  });
  assert.match(reply, /## 搜索摘要/);
  assert.match(reply, /航班动态/);
  assert.match(reply, /来源：/);
});
