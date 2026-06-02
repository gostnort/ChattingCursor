import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildKnowledgeContext,
  createKnowledgeChild,
  deleteKnowledgeNode,
  listKnowledgeTree,
  renameKnowledgeNode,
  uploadKnowledgeMarkdown,
} from "./knowledge-store.js";


test("知识库：创建子节点、上传 markdown、拼装上下文", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-knowledge-"));
  t.after(async () => {
    process.env.CHATTINGCURSOR_KNOWLEDGE_DIR = "";
    await rm(tempDir, { recursive: true, force: true });
  });
  process.env.CHATTINGCURSOR_KNOWLEDGE_DIR = tempDir;
  const tree = await listKnowledgeTree();
  assert.equal(tree.rootId, "root");
  const child = await createKnowledgeChild("root", "测试主题");
  const renamed = await renameKnowledgeNode(child.id, "重命名主题");
  assert.equal(renamed.name, "重命名主题");
  await uploadKnowledgeMarkdown(child.id, "# 说明\n离线模型可读此段。", ["测试标签"]);
  const treeAfter = await listKnowledgeTree();
  const uploaded = treeAfter.nodes.find((node) => node.id === child.id);
  assert.deepEqual(uploaded?.tags, ["测试标签"]);
  const context = await buildKnowledgeContext(8000);
  assert.match(context, /重命名主题/);
  assert.match(context, /离线模型可读此段/);
  await deleteKnowledgeNode(child.id);
  const indexRaw = await readFile(path.join(tempDir, "index.json"), "utf8");
  const index = JSON.parse(indexRaw) as { nodes: Record<string, unknown> };
  assert.equal(index.nodes[child.id], undefined);
});
