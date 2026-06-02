import assert from "node:assert/strict";
import test from "node:test";
import {
  extractSearchKeywordCandidates,
  extractSearchKeywords,
  formatHistorySearchReply,
  hasHistorySearchIntent,
  mergeHistorySearchHits,
  searchSessionMessages,
} from "./history-search-intent.js";


test("hasHistorySearchIntent 识别「还记得…之前说过」类回忆问句", () => {
  assert.equal(hasHistorySearchIntent("你还记得我之前说过，我每天希望多少热量缺口吗？"), true);
});


test("extractSearchKeywords 从回忆问句提取主题而非整句", () => {
  const prompt = "你还记得我之前说过，我每天希望多少热量缺口吗？";
  const keywords = extractSearchKeywords(prompt);
  assert.equal(keywords.includes("你还记得"), false);
  assert.equal(keywords.includes("热量缺口"), true);
});


test("extractSearchKeywordCandidates 包含拆出的中文词组", () => {
  const prompt = "你还记得我之前说过，我每天希望多少热量缺口吗？";
  const candidates = extractSearchKeywordCandidates(prompt);
  assert.ok(candidates.some((term) => term.includes("热量缺口")));
});


test("searchSessionMessages 能在当前会话 user 消息中命中", () => {
  const messages = [
    { role: "user", content: "我每天希望保持 500 大卡的热量缺口。" },
    { role: "assistant", content: "好的，已记录你的热量目标。" },
    { role: "user", content: "你还记得我之前说过，我每天希望多少热量缺口吗？" },
  ];
  const hits = searchSessionMessages(
    messages,
    extractSearchKeywordCandidates(messages[2].content),
    "session-abc",
    messages[2].content,
  );
  assert.ok(hits.length >= 1);
  const userHit = hits.find((hit) => hit.snippet.startsWith("User:"));
  assert.ok(userHit);
  assert.match(userHit.snippet, /热量缺口/);
  assert.match(userHit.file, /当前会话/);
});


test("mergeHistorySearchHits 会话结果排在磁盘结果之前", () => {
  const sessionHits = [{ file: "a（当前会话）", snippet: "session hit", line: 1 }];
  const diskHits = [{ file: "a.txt", snippet: "disk hit", line: 2 }];
  const merged = mergeHistorySearchHits(sessionHits, diskHits);
  assert.equal(merged[0]?.snippet, "session hit");
  assert.equal(merged.length, 2);
});


test("formatHistorySearchReply 无命中时展示主检索词", () => {
  const reply = formatHistorySearchReply("热量缺口", []);
  assert.match(reply, /未找到与「热量缺口」相关的内容/);
});
