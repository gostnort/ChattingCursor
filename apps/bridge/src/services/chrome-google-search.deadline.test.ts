import assert from "node:assert/strict";
import test from "node:test";
import {
  WEBSEARCH_GLOBAL_DEADLINE_MS,
  appendWebSearchTimeoutFooter,
  buildWebSearchTimeoutFooter,
  isWebSearchDeadlineExceeded,
} from "./chrome-google-search.js";


test("WEBSEARCH_GLOBAL_DEADLINE_MS 为 60 秒", () => {
  assert.equal(WEBSEARCH_GLOBAL_DEADLINE_MS, 60_000);
});


test("isWebSearchDeadlineExceeded：未到期", () => {
  const deadline = 1_000_000;
  assert.equal(isWebSearchDeadlineExceeded(deadline, 999_999), false);
});


test("isWebSearchDeadlineExceeded：刚好到期", () => {
  const deadline = 1_000_000;
  assert.equal(isWebSearchDeadlineExceeded(deadline, 1_000_000), true);
});


test("isWebSearchDeadlineExceeded：已过期", () => {
  const deadline = 1_000_000;
  assert.equal(isWebSearchDeadlineExceeded(deadline, 1_000_001), true);
});


test("buildWebSearchTimeoutFooter：中文查询", () => {
  assert.equal(
    buildWebSearchTimeoutFooter("北京天气"),
    "（检索超时 60 秒，以下为已收集资料的综合回答）",
  );
});


test("buildWebSearchTimeoutFooter：英文查询", () => {
  assert.match(
    buildWebSearchTimeoutFooter("weather in London"),
    /timed out after 60 seconds/i,
  );
});


test("appendWebSearchTimeoutFooter：保留正文并追加页脚", () => {
  const merged = appendWebSearchTimeoutFooter("要点一\n要点二", "测试");
  assert.match(merged, /^要点一/);
  assert.match(merged, /检索超时 60 秒/);
});


test("appendWebSearchTimeoutFooter：无正文时仅页脚", () => {
  assert.equal(
    appendWebSearchTimeoutFooter(undefined, "测试"),
    buildWebSearchTimeoutFooter("测试"),
  );
});
