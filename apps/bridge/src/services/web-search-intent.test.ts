import assert from "node:assert/strict";
import test from "node:test";
import {
  extractWebSearchQuery,
  extractWebSearchUserContext,
  formatWebSearchReply,
  hasWebSearchIntent,
} from "./web-search-intent.js";


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


test("hasWebSearchIntent 识别行内 /websearch（中英文混排）", () => {
  const mixed =
    "目前cerritos的市长是哪个国家出生的? /websearch cerritos mayor birth place";
  assert.equal(hasWebSearchIntent(mixed), true);
  assert.equal(hasWebSearchIntent("foo bar /websearch cerritos mayor birth place"), true);
  assert.equal(hasWebSearchIntent("/websearch cerritos mayor"), true);
});


test("extractWebSearchQuery 行内指令只取 /websearch 之后至行尾", () => {
  const mixed =
    "目前cerritos的市长是哪个国家出生的? /websearch cerritos mayor birth place";
  assert.equal(extractWebSearchQuery(mixed), "cerritos mayor birth place");
  assert.equal(
    extractWebSearchQuery("foo bar /websearch cerritos mayor birth place"),
    "cerritos mayor birth place",
  );
});


test("extractWebSearchUserContext 取指令前的行内背景", () => {
  const mixed =
    "目前cerritos的市长是哪个国家出生的? /websearch cerritos mayor birth place";
  assert.equal(
    extractWebSearchUserContext(mixed),
    "目前cerritos的市长是哪个国家出生的?",
  );
});


test("extractWebSearchQuery 多行取首个 /websearch 查询", () => {
  const multi = "第一行 /websearch query one\n第二行 /websearch query two";
  assert.equal(extractWebSearchQuery(multi), "query one");
});


test("formatWebSearchReply 含搜索摘要与来源", () => {
  const reply = formatWebSearchReply("机票", {
    ok: true,
    endpoint: "http://127.0.0.1:9222",
    searchUrl: "https://www.google.com/search?q=%E6%9C%BA%E7%A5%A8",
    pageUrl: "https://www.google.com/search?q=%E6%9C%BA%E7%A5%A8",
    serpItems: [{ title: "航班动态", url: "https://example.com", snippet: "CA988" }],
    synthesizedSummary: "- 航班动态：CA988",
  });
  assert.match(reply, /## 搜索摘要/);
  assert.match(reply, /## 搜索结果/);
  assert.match(reply, /航班动态/);
  assert.match(reply, /来源：/);
  assert.match(reply, /标签页已自动关闭/);
});
