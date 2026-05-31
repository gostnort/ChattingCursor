import assert from "node:assert/strict";
import test from "node:test";
import {
  buildModelDisplayAuthorList,
  formatAuthorDisplayName,
  formatModelDisplayLabel,
  formatModelDisplayLabelFromId,
  formatModelDisplayName,
  formatModelDropdownLabel,
  formatModelDropdownLabelFromId,
  formatModelSlugDisplayName,
} from "./model-display-name.js";


const LONG_AUTHORS = buildModelDisplayAuthorList(["BartonMinus", "BartonPlus", "bartowski", "google"]);


test("formatAuthorDisplayName 短名保留、长名 DOS 缩短", () => {
  assert.equal(formatAuthorDisplayName("google"), "google");
  assert.equal(formatAuthorDisplayName("bartowski", LONG_AUTHORS), "bart~3");
  assert.equal(formatAuthorDisplayName("BartonPlus", LONG_AUTHORS), "Bart~2");
  assert.equal(formatAuthorDisplayName("BartonMinus", LONG_AUTHORS), "Bart~1");
});


test("formatAuthorDisplayName 不同全名获得不同 ~N", () => {
  const authors = buildModelDisplayAuthorList(["BartonMinus", "BartonPlus"]);
  assert.equal(formatAuthorDisplayName("BartonMinus", authors), "Bart~1");
  assert.equal(formatAuthorDisplayName("BartonPlus", authors), "Bart~2");
});


test("formatAuthorDisplayName 单作者时 bartowski 为 bart~1", () => {
  const authors = buildModelDisplayAuthorList(["bartowski"]);
  assert.equal(formatAuthorDisplayName("bartowski", authors), "bart~1");
  assert.equal(
    formatModelDisplayName("bartowski", "google_gemma4", authors),
    "bart~1/google",
  );
});


test("formatModelSlugDisplayName 遇非字母数字即截断", () => {
  assert.equal(formatModelSlugDisplayName("google_gemma4"), "google");
  assert.equal(formatModelSlugDisplayName("Gemma4-25b"), "Gemma4");
  assert.equal(
    formatModelSlugDisplayName("google_gemma-4-26B-A4B-it-GGUF"),
    "google",
  );
});


test("formatModelDropdownLabel 下拉框保留完整 author/modelSlug", () => {
  assert.equal(
    formatModelDropdownLabel("bartowski", "google_gemma-4-26B-A4B-it-GGUF"),
    "bartowski/google_gemma-4-26B-A4B-it-GGUF",
  );
  assert.equal(formatModelDropdownLabel("google", "gemma4"), "google/gemma4");
});


test("formatModelDropdownLabelFromId 解析 local-llm id 为完整标签", () => {
  assert.equal(
    formatModelDropdownLabelFromId("local-llm/bartowski/google_gemma-4-26B-A4B-it-GGUF"),
    "bartowski/google_gemma-4-26B-A4B-it-GGUF",
  );
});


test("formatModelDisplayName 气泡 pill 组合 DOS 作者与 slug 前缀", () => {
  assert.equal(
    formatModelDisplayName("bartowski", "google_gemma-4-26B-A4B-it-GGUF", LONG_AUTHORS),
    "bart~3/google",
  );
});


test("formatModelDisplayLabelFromId 气泡解析 local-llm id", () => {
  assert.equal(
    formatModelDisplayLabelFromId("local-llm/bartowski/google_gemma-4-26B-A4B-it-GGUF", LONG_AUTHORS),
    "bart~3/google",
  );
});


test("formatModelDisplayLabel 气泡接受 raw label", () => {
  assert.equal(
    formatModelDisplayLabel("bartowski/google_gemma-4-26B-A4B-it-GGUF", LONG_AUTHORS),
    "bart~3/google",
  );
});
