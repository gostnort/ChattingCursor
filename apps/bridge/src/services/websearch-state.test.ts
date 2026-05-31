import assert from "node:assert/strict";
import test from "node:test";
import {
  hashWebSearchPageContent,
  maxLinksForWebSearchPass,
  resolveWebSearchPassByK,
  webSearchQueryHash,
  WEBSEARCH_LINKS_PER_SERP_PAGE,
  WEBSEARCH_PASS_DEADLINE_MS,
  WEBSEARCH_REPEAT_PASS_DEADLINE_MS,
} from "./websearch-state.js";
import {
  collectNewOrganicResultUrls,
  collectRandomNewOrganicResultUrls,
  normalizeOrganicResultUrl,
} from "./google-serp-parse.js";


test("resolveWebSearchPassByK k=1 为第1–3页顺序 60s", () => {
  const plan = resolveWebSearchPassByK(1);
  assert.equal(plan.isRepeat, false);
  assert.equal(plan.passK, 1);
  assert.equal(plan.passes.length, 1);
  assert.deepEqual(plan.passes[0].offsets, [0, 10, 20]);
  assert.equal(plan.passes[0].randomLinkSelection, false);
  assert.equal(plan.passes[0].deadlineMs, WEBSEARCH_PASS_DEADLINE_MS);
  assert.equal(plan.passes[0].minPage, 1);
  assert.equal(plan.passes[0].maxPage, 3);
});


test("resolveWebSearchPassByK k=2 为第4–10页随机 120s", () => {
  const plan = resolveWebSearchPassByK(2);
  assert.equal(plan.isRepeat, true);
  assert.equal(plan.passK, 2);
  assert.deepEqual(plan.passes[0].offsets, [30, 40, 50, 60, 70, 80, 90]);
  assert.equal(plan.passes[0].randomLinkSelection, true);
  assert.equal(plan.passes[0].deadlineMs, WEBSEARCH_REPEAT_PASS_DEADLINE_MS);
  assert.equal(plan.passes[0].minPage, 4);
  assert.equal(plan.passes[0].maxPage, 10);
});


test("resolveWebSearchPassByK k=3 为第11–15页", () => {
  const plan = resolveWebSearchPassByK(3);
  assert.deepEqual(plan.passes[0].offsets, [100, 110, 120, 130, 140]);
  assert.equal(plan.passes[0].minPage, 11);
  assert.equal(plan.passes[0].maxPage, 15);
  assert.equal(plan.passes[0].deadlineMs, WEBSEARCH_PASS_DEADLINE_MS);
});


test("resolveWebSearchPassByK k=4 为第16–20页", () => {
  const plan = resolveWebSearchPassByK(4);
  assert.deepEqual(plan.passes[0].offsets, [150, 160, 170, 180, 190]);
  assert.equal(plan.passes[0].minPage, 16);
  assert.equal(plan.passes[0].maxPage, 20);
});


test("resolveWebSearchPassByK k=5 为第21–25页", () => {
  const plan = resolveWebSearchPassByK(5);
  assert.deepEqual(plan.passes[0].offsets, [200, 210, 220, 230, 240]);
  assert.equal(plan.passes[0].minPage, 21);
  assert.equal(plan.passes[0].maxPage, 25);
});


test("maxLinksForWebSearchPass 每 SERP 页 3 条", () => {
  const plan = resolveWebSearchPassByK(1);
  assert.equal(maxLinksForWebSearchPass(plan.passes[0]), 9);
});


test("WEBSEARCH_LINKS_PER_SERP_PAGE 为 3", () => {
  assert.equal(WEBSEARCH_LINKS_PER_SERP_PAGE, 3);
});


test("webSearchQueryHash 规范化空白与大小写", () => {
  assert.equal(webSearchQueryHash("Hello  World"), webSearchQueryHash("hello world"));
});


test("hashWebSearchPageContent 相同正文得到相同哈希", () => {
  const a = hashWebSearchPageContent("段落一\n\n段落二");
  const b = hashWebSearchPageContent("段落一 段落二");
  assert.equal(a, b);
});


test("normalizeOrganicResultUrl 解包 Google 跳转", () => {
  const wrapped = normalizeOrganicResultUrl(
    "https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fpage&sa=U",
  );
  assert.equal(wrapped, "https://example.com/page");
});


test("collectNewOrganicResultUrls 去重并遵守上限", () => {
  const seen = new Set<string>(["https://seen.example/"]);
  const items = [
    { title: "Seen", url: "https://seen.example/" },
    { title: "New", url: "https://new.example/a" },
    { title: "New2", url: "https://new.example/b" },
  ];
  const batch = collectNewOrganicResultUrls(items, seen, {
    perPageMax: 1,
    totalMax: 2,
    alreadyQueued: 1,
  });
  assert.deepEqual(batch.urls, ["https://new.example/a"]);
  assert.equal(batch.truncated, true);
});


test("collectRandomNewOrganicResultUrls 随机抽取至多 perPageMax 条", () => {
  const seen = new Set<string>();
  const items = Array.from({ length: 8 }, (_, index) => ({
    title: `Item ${index}`,
    url: `https://example.com/${index}`,
  }));
  const batch = collectRandomNewOrganicResultUrls(items, seen, {
    perPageMax: 3,
    totalMax: 30,
    alreadyQueued: 0,
  });
  assert.equal(batch.urls.length, 3);
  for (const href of batch.urls) {
    assert.match(href, /^https:\/\/example\.com\/\d+$/);
  }
});
