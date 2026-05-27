import assert from "node:assert/strict";
import test from "node:test";
import {
  computeCrawlBatchCount,
  WEBSEARCH_CRAWL_BATCH_SIZE,
} from "./chrome-google-search.js";


test("WEBSEARCH_CRAWL_BATCH_SIZE 为 5", () => {
  assert.equal(WEBSEARCH_CRAWL_BATCH_SIZE, 5);
});


test("computeCrawlBatchCount：12 链接分 3 批", () => {
  assert.equal(computeCrawlBatchCount(12, 5), 3);
});


test("computeCrawlBatchCount：5 链接分 1 批", () => {
  assert.equal(computeCrawlBatchCount(5, 5), 1);
});


test("computeCrawlBatchCount：0 链接分 0 批", () => {
  assert.equal(computeCrawlBatchCount(0, 5), 0);
});
