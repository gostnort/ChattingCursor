import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { buildLocalLlmModelId, localLlmModelIdToRoutePath } from "../services/local-llm-store.js";
import { registerLocalLlmRoutes } from "./local-llm.js";


test("DELETE /local-llm/installed/* 删除整个模型目录", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-local-llm-route-del-"));
  const previous = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  t.after(async () => {
    process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previous ?? "";
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = tempDir;
  const author = "bartowski";
  const modelSlug = "google_gemma-4-26B-A4B-it-GGUF";
  const modelId = buildLocalLlmModelId(author, modelSlug);
  const modelDirPath = path.join(tempDir, author, modelSlug);
  await mkdir(modelDirPath, { recursive: true });
  await writeFile(path.join(modelDirPath, "weights.gguf"), "data");
  await writeFile(path.join(modelDirPath, "model.json"), JSON.stringify({
    id: modelId,
    author,
    modelSlug,
    repoId: `${author}/${modelSlug}`,
    displayName: modelSlug,
    ggufGroupKey: "test",
    filenames: ["weights.gguf"],
    defaultPrompt: "hi",
    installedAt: new Date().toISOString(),
  }));
  const app = Fastify({ logger: false });
  await registerLocalLlmRoutes(app);
  const routePath = localLlmModelIdToRoutePath(modelId);
  const response = await app.inject({
    method: "DELETE",
    url: `/local-llm/installed/${routePath}`,
    remoteAddress: "127.0.0.1",
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { ok: boolean; unloaded?: boolean; deleted?: boolean };
  assert.equal(body.ok, true);
  assert.equal(body.deleted, true);
  assert.equal(existsSync(modelDirPath), false);
  await app.close();
});
