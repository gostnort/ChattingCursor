import assert from "node:assert/strict";
import test from "node:test";
import {
  WEBSEARCH_PASS_DEADLINE_MS,
  WEBSEARCH_REPEAT_PASS_DEADLINE_MS,
} from "./websearch-state.js";
import {
  appendWebSearchTimeoutFooter,
  buildWebSearchTimeoutFooter,
  isWebSearchDeadlineExceeded,
} from "./chrome-google-search.js";


test("抓取时限 k=1 为 60s、k=2 为 120s", () => {
  assert.equal(WEBSEARCH_PASS_DEADLINE_MS, 60_000);
  assert.equal(WEBSEARCH_REPEAT_PASS_DEADLINE_MS, 120_000);
});


test("isWebSearchDeadlineExceeded：未到期", () => {
  const deadline = 1_000_000;
  assert.equal(isWebSearchDeadlineExceeded(deadline, 999_999), false);
});


test("isWebSearchDeadlineExceeded：刚好到期", () => {
  const deadline = 1_000_000;
  assert.equal(isWebSearchDeadlineExceeded(deadline, 1_000_000), true);
});


test("buildWebSearchTimeoutFooter：中文查询默认 60 秒", () => {
  assert.equal(
    buildWebSearchTimeoutFooter("北京天气"),
    "（检索超时 60 秒，以下为已收集资料的综合回答）",
  );
});


test("buildWebSearchTimeoutFooter：可传入本次 pass 预算", () => {
  assert.match(
    buildWebSearchTimeoutFooter("weather", WEBSEARCH_REPEAT_PASS_DEADLINE_MS),
    /120 seconds/i,
  );
});


test("appendWebSearchTimeoutFooter：保留正文并追加页脚", () => {
  const merged = appendWebSearchTimeoutFooter("要点一\n要点二", "测试", 60_000);
  assert.match(merged, /^要点一/);
  assert.match(merged, /检索超时 60 秒/);
});
