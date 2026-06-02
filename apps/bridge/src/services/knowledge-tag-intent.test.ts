import assert from "node:assert/strict";
import test from "node:test";
import {
  extractMentionedKnowledgeTags,
  shouldRunKnowledgeTagPipeline,
} from "./knowledge-tag-intent.js";


test("extractMentionedKnowledgeTags 匹配已知标签", () => {
  const tags = extractMentionedKnowledgeTags("请根据 #健身 计划回答", ["健身", "饮食"]);
  assert.deepEqual(tags, ["健身"]);
});


test("shouldRunKnowledgeTagPipeline 对话中含标签时触发", () => {
  const run = shouldRunKnowledgeTagPipeline(
    "总结一下",
    ["项目A"],
    [{ role: "user", content: "打开项目A 文档" }],
  );
  assert.equal(run, true);
});
