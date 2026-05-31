import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWebSearchSearchSummaryMessages,
  buildWebSearchSynthesisMessages,
  buildWebSearchSynthesisUserPrompt,
  buildWebSearchSynthesisUnavailableMessage,
  formatCrawledPagesForSearchSummary,
  resolveWebSearchSummarizeTimeoutMs,
  runWebSearchPipeline,
  summarizeWebSearchMaterialWithProvider,
  summarizeWebSearchWithProvider,
} from "./web-search-summarize.js";


test("buildWebSearchSynthesisUserPrompt 保留用户问题与搜索摘要", () => {
  const prompt = buildWebSearchSynthesisUserPrompt(
    {
      query: "claude opus 4.8",
      userIntent: "最近opus 4.8 有什么改进？",
      pagesQueued: 5,
      pagesCrawled: 3,
    },
    "Opus 4.8 推理与工具调用均有提升。",
  );
  assert.match(prompt, /最近opus 4\.8 有什么改进/);
  assert.match(prompt, /claude opus 4\.8/);
  assert.match(prompt, /2 个排队结果页未能抓取/);
  assert.match(prompt, /Opus 4\.8 推理与工具调用均有提升/);
});


test("buildWebSearchSynthesisMessages 含中文系统提示", () => {
  const messages = buildWebSearchSynthesisMessages(
    {
      query: "test",
      userIntent: "测试问题",
      aggregateExcerpt: "body",
      structuredBullets: "",
      pagesQueued: 0,
      pagesCrawled: 0,
    },
    "搜索摘要正文",
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "system");
  assert.match(messages[0]?.content ?? "", /综合总结/);
  assert.match(messages[1]?.content ?? "", /测试问题/);
});


test("buildWebSearchSearchSummaryMessages 含搜索摘要系统提示", () => {
  const messages = buildWebSearchSearchSummaryMessages(
    {
      query: "trump",
      fullPrompt: "请检索 /websearch trump",
      aggregateExcerpt: "",
      structuredBullets: "",
      pagesQueued: 1,
      pagesCrawled: 1,
    },
    "## Page\nhttps://example.com\n正文",
  );
  assert.match(messages[0]?.content ?? "", /综合摘要/);
});


test("summarizeWebSearchWithProvider 使用 mock 返回最终回答", async () => {
  const synthesis = await summarizeWebSearchWithProvider(
    {
      query: "claude opus 4.8",
      userIntent: "最近opus 4.8 有什么改进？",
      aggregateExcerpt: "ignored",
      structuredBullets: "",
      pagesQueued: 2,
      pagesCrawled: 2,
    },
    async () => "Opus 4.8 有如下的改进：推理更快、工具调用更稳。",
    "搜索摘要：更快推理。",
  );
  assert.equal(synthesis, "Opus 4.8 有如下的改进：推理更快、工具调用更稳。");
});


test("summarizeWebSearchWithProvider 无摘要时返回 undefined", async () => {
  let called = false;
  const synthesis = await summarizeWebSearchWithProvider(
    {
      query: "empty",
      aggregateExcerpt: "",
      structuredBullets: "",
      pagesQueued: 0,
      pagesCrawled: 0,
    },
    async () => {
      called = true;
      return "不应调用";
    },
    "",
  );
  assert.equal(synthesis, undefined);
  assert.equal(called, false);
});


test("formatCrawledPagesForSearchSummary 格式化多页", () => {
  const block = formatCrawledPagesForSearchSummary(
    "topic",
    [{ title: "A", url: "https://a.example", text: "Body A" }],
    true,
  );
  assert.match(block, /### A/);
  assert.match(block, /Body A/);
});


test("runWebSearchPipeline LLM-1 摘要再 LLM-2 回答", async () => {
  let callIndex = 0;
  const answer = await runWebSearchPipeline(
    {
      query: "trump visit",
      userIntent: "请给出你的判断",
      fullPrompt: "请给出你的判断 /websearch trump visit",
      aggregateExcerpt: "raw serp excerpt",
      structuredBullets: "- News headline",
      pagesQueued: 1,
      pagesCrawled: 1,
      crawledPages: [
        { title: "News", url: "https://news.example", text: "President made remarks." },
      ],
    },
    {
      skipModelReady: true,
      provider: async (messages) => {
        callIndex += 1;
        const user = messages.find((message) => message.role === "user")?.content ?? "";
        if (callIndex === 1) {
          assert.match(user, /President made remarks/);
          return "搜索摘要：批评言论要点。";
        }
        assert.match(user, /搜索摘要：批评言论要点/);
        assert.match(user, /请给出你的判断/);
        assert.doesNotMatch(user, /News headline/);
        return "综合判断：相关批评需要结合外交背景理解，不宜简单定性。";
      },
    },
  );
  assert.equal(callIndex, 2);
  assert.match(answer ?? "", /综合判断/);
  assert.doesNotMatch(answer ?? "", /News headline/);
});


test("runWebSearchPipeline LLM 失败时用原文 fallback 再试最终回答", async () => {
  let callIndex = 0;
  const answer = await runWebSearchPipeline(
    {
      query: "topic",
      userIntent: "问题",
      aggregateExcerpt: "",
      structuredBullets: "",
      pagesQueued: 1,
      pagesCrawled: 1,
      crawledPages: [{ title: "P", url: "https://p.example", text: "正文材料" }],
    },
    {
      skipModelReady: true,
      provider: async (messages) => {
        callIndex += 1;
        const system = messages[0]?.content ?? "";
        if (callIndex === 1) {
          assert.match(system, /综合摘要/);
          return undefined;
        }
        const user = messages.find((message) => message.role === "user")?.content ?? "";
        if (user.includes("正文材料") && user.includes("用户问题")) {
          return "基于材料的回答。";
        }
        return undefined;
      },
    },
  );
  assert.ok(callIndex >= 2);
  assert.match(answer ?? "", /基于材料的回答/);
});


test("summarizeWebSearchMaterialWithProvider 无材料返回 undefined", async () => {
  const summary = await summarizeWebSearchMaterialWithProvider(
    { query: "x", aggregateExcerpt: "", structuredBullets: "", pagesQueued: 0, pagesCrawled: 0 },
    async () => "不应调用",
    "",
  );
  assert.equal(summary, undefined);
});


test("buildWebSearchSynthesisUnavailableMessage 为中文提示", () => {
  const message = buildWebSearchSynthesisUnavailableMessage({
    query: "trump visit",
    userIntent: "请判断",
    fullPrompt: "请判断 /websearch trump",
  });
  assert.match(message, /未能用当前所选模型/);
  assert.doesNotMatch(message, /^- \*\*/);
});


test("resolveWebSearchSummarizeTimeoutMs 本地模型使用更长超时", () => {
  assert.equal(
    resolveWebSearchSummarizeTimeoutMs("local-llm/bartowski/google_gemma-4-26B-A4B-it-GGUF"),
    600_000,
  );
  assert.equal(resolveWebSearchSummarizeTimeoutMs("composer-2"), 90_000);
  assert.equal(resolveWebSearchSummarizeTimeoutMs(undefined), 90_000);
});
