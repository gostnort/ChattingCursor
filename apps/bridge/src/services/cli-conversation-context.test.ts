import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createKnowledgeChild,
  uploadKnowledgeMarkdown,
} from "./knowledge-store.js";
import { buildCliPromptFromSession } from "./cli-conversation-context.js";
import type { SessionMessage } from "./session-store.js";


const ts = "2026-01-01T00:00:00.000Z";


function msg(role: SessionMessage["role"], content: string): SessionMessage {
  return { role, content, timestamp: ts };
}


test("buildCliPromptFromSession：含系统说明、知识库与对话历史", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-cli-ctx-"));
  t.after(async () => {
    process.env.CHATTINGCURSOR_KNOWLEDGE_DIR = "";
    await rm(tempDir, { recursive: true, force: true });
  });
  process.env.CHATTINGCURSOR_KNOWLEDGE_DIR = tempDir;
  const child = await createKnowledgeChild("root", "CLI 知识");
  await uploadKnowledgeMarkdown(child.id, "# 条目\n供 CLI 读取。");
  const history = [
    msg("user", "第一轮"),
    msg("assistant", "第一轮回复"),
    msg("user", "第二轮"),
  ];
  const prompt = await buildCliPromptFromSession({ prompt: "第二轮", history });
  assert.match(prompt, /【系统说明】/);
  assert.match(prompt, /# 知识库/);
  assert.match(prompt, /CLI 知识/);
  assert.match(prompt, /【对话历史】/);
  assert.match(prompt, /用户: 第一轮/);
  assert.match(prompt, /助手: 第一轮回复/);
  assert.match(prompt, /用户: 第二轮/);
  assert.doesNotMatch(prompt, /【当前用户消息】/);
});


test("buildCliPromptFromSession：历史未含当前 prompt 时追加当前用户消息", async () => {
  const prompt = await buildCliPromptFromSession({
    prompt: "新问题",
    history: [msg("user", "旧问题"), msg("assistant", "旧回复")],
  });
  assert.match(prompt, /【当前用户消息】/);
  assert.match(prompt, /新问题/);
});
