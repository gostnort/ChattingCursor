import assert from "node:assert/strict";
import test from "node:test";
import { GOOGLE_PAGE_HTML_CAPTURE_EXPRESSION } from "./google-serp-parse.js";


test("GOOGLE_PAGE_HTML_CAPTURE_EXPRESSION 返回 outerHTML", () => {
  assert.match(GOOGLE_PAGE_HTML_CAPTURE_EXPRESSION, /outerHTML/);
  assert.match(GOOGLE_PAGE_HTML_CAPTURE_EXPRESSION, /document\.title/);
});
