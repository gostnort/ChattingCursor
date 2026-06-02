import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExternalDataNotFoundMessage,
  formatCollectedChunksToMaterial,
  runExternalDataPipeline,
} from "./external-data-pipeline.js";


test("formatCollectedChunksToMaterial 格式化历史片段", () => {
  const material = formatCollectedChunksToMaterial(
    [{ source: "history", title: "a.txt", text: "User: 热量缺口 500 大卡" }],
    true,
  );
  assert.match(material, /热量缺口/);
  assert.match(material, /a\.txt/);
});


test("buildExternalDataNotFoundMessage 历史源明确未找到", () => {
  const message = buildExternalDataNotFoundMessage({
    query: "热量缺口",
    userIntent: "还记得热量缺口吗",
    sourceKind: "history",
  });
  assert.match(message, /未找到/);
  assert.match(message, /热量缺口/);
});


test("runExternalDataPipeline 无片段时返回未找到", async () => {
  const answer = await runExternalDataPipeline(
    {
      chunks: [],
      userIntent: "测试",
      query: "测试",
      sourceKind: "history",
    },
    { skipModelReady: true },
  );
  assert.match(answer ?? "", /未找到/);
});


test("runExternalDataPipeline LLM-1 再 LLM-2", async () => {
  let callIndex = 0;
  const answer = await runExternalDataPipeline(
    {
      chunks: [{ source: "history", title: "会话", text: "用户曾提到热量缺口 500 大卡。" }],
      userIntent: "我每天希望多少热量缺口？",
      query: "热量缺口",
      fullPrompt: "你还记得热量缺口吗？",
      sourceKind: "history",
    },
    {
      skipModelReady: true,
      provider: async () => {
        callIndex += 1;
        if (callIndex === 1) {
          return "摘要：热量缺口约 500 大卡。";
        }
        return "你之前说过希望每天约 500 大卡的热量缺口。";
      },
    },
  );
  assert.equal(callIndex, 2);
  assert.match(answer ?? "", /500/);
});
