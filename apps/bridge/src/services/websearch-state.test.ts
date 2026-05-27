import assert from "node:assert/strict";
import test from "node:test";
import {
  hashWebSearchPageContent,
  resolveSerpStartOffsets,
  webSearchQueryHash,
  WEBSEARCH_FIRST_RUN_OFFSETS,
} from "./websearch-state.js";
import { collectNewOrganicResultUrls, normalizeOrganicResultUrl } from "./google-serp-parse.js";


test("resolveSerpStartOffsets 首次为第2–3页", () => {
  const first = resolveSerpStartOffsets(undefined);
  assert.deepEqual(first.offsets, [...WEBSEARCH_FIRST_RUN_OFFSETS]);
  assert.equal(first.isRepeat, false);
});


test("resolveSerpStartOffsets 重复查询再推进5页", () => {
  const repeat = resolveSerpStartOffsets(20);
  assert.deepEqual(repeat.offsets, [30, 40, 50, 60, 70]);
  assert.equal(repeat.isRepeat, true);
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
