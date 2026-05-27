import assert from "node:assert/strict";
import test from "node:test";
import {
  extractWebSearchQuery,
  extractWebSearchUserContext,
  extractWebSearchUserIntent,
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


test("extractWebSearchUserIntent 优先行内背景", () => {
  const mixed =
    "古埃及太阳神拉在最早文献里叫什么? /websearch ra in oldest egypt history";
  assert.equal(
    extractWebSearchUserIntent(mixed, []),
    "古埃及太阳神拉在最早文献里叫什么?",
  );
});


test("formatWebSearchReply 仅输出综合回答与页脚", () => {
  const reply = formatWebSearchReply("古埃及太阳神拉在最早文献里叫什么?", {
    ok: true,
    synthesis: "在古王国时期，太阳神常称 Ra（拉），最早可追溯至金字塔铭文等文献。",
    meta: {
      endpoint: "http://127.0.0.1:9222",
      searchUrl: "https://www.google.com/search?q=ra",
      linksCrawled: 8,
      serpStartOffsets: [10, 20],
    },
  });
  assert.match(reply, /## 回答/);
  assert.match(reply, /太阳神常称 Ra/);
  assert.match(reply, /已检索 8 个来源/);
  assert.match(reply, /第 2–3 页/);
  assert.doesNotMatch(reply, /## 搜索结果/);
  assert.doesNotMatch(reply, /页面摘录/);
});


test("formatWebSearchReply 页脚可仅含分页信息", () => {
  const reply = formatWebSearchReply("测试", {
    ok: true,
    synthesis: "综合结论示例。",
    meta: {
      endpoint: "http://127.0.0.1:9222",
      searchUrl: "https://www.google.com/search?q=test",
      linksCrawled: 10,
      serpStartOffsets: [10, 20],
    },
  });
  assert.match(reply, /已检索 10 个来源/);
  assert.doesNotMatch(reply, /分 \d+ 批打开/);
});
