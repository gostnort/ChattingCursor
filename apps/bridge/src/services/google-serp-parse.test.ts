import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStructuredSerpSummary,
  detectGoogleAccessBlock,
  parseGoogleSerpEvaluateValue,
  preferChineseWebSearchReply,
} from "./google-serp-parse.js";


test("detectGoogleAccessBlock 识别同意页与验证码", () => {
  assert.equal(
    detectGoogleAccessBlock("https://consent.google.com/ml", "Before you continue"),
    "consent",
  );
  assert.equal(
    detectGoogleAccessBlock("https://www.google.com/search", "unusual traffic from your network"),
    "captcha",
  );
  assert.equal(detectGoogleAccessBlock("https://www.google.com/search?q=a", "正常结果"), null);
});


test("parseGoogleSerpEvaluateValue 解析 mock CDP 结果", () => {
  const snapshot = parseGoogleSerpEvaluateValue({
    title: "test - Google Search",
    url: "https://www.google.com/search?q=test",
    text: "body",
    block: null,
    items: [
      { title: "Example", url: "https://example.com", snippet: "Snippet text" },
    ],
  });
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0]?.title, "Example");
  assert.equal(snapshot.block, null);
});


test("buildStructuredSerpSummary 输出条目与中文拦截提示", () => {
  const bullets = buildStructuredSerpSummary("机票", {
    items: [{ title: "航班", url: "https://example.com", snippet: "CA988" }],
    block: null,
  });
  assert.match(bullets, /\*\*航班\*\*/);
  assert.match(bullets, /example\.com/);
  const blocked = buildStructuredSerpSummary("test", {
    items: [],
    block: "captcha",
  });
  assert.match(blocked, /验证码|CAPTCHA/i);
});


test("preferChineseWebSearchReply", () => {
  assert.equal(preferChineseWebSearchReply("哲学家"), true);
  assert.equal(preferChineseWebSearchReply("flight status"), false);
});
