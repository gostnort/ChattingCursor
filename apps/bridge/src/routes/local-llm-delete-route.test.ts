import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { isOriginAllowed, loadConfig } from "../config.js";
import {
  buildLocalLlmModelId,
  listInstalledLocalLlmModels,
  localLlmModelIdToRoutePath,
} from "../services/local-llm-store.js";
import { registerLocalLlmRoutes } from "./local-llm.js";


/** 与 index.ts 一致的 CORS 注册 */
async function registerBridgeCors(app: ReturnType<typeof Fastify>): Promise<void> {
  const config = loadConfig();
  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, isOriginAllowed(origin, config.corsOrigins));
    },
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
}


test("OPTIONS 预检允许来自 Vite 的 DELETE", async () => {
  const app = Fastify({ logger: false });
  await registerBridgeCors(app);
  await registerLocalLlmRoutes(app);
  const response = await app.inject({
    method: "OPTIONS",
    url: "/local-llm/installed/local-llm/test-delete-tmp/throwaway-model",
    headers: {
      origin: "http://127.0.0.1:43210",
      "access-control-request-method": "DELETE",
    },
  });
  assert.equal(response.statusCode, 204);
  const allowedMethods = response.headers["access-control-allow-methods"] ?? "";
  assert.match(allowedMethods, /DELETE/);
  assert.equal(response.headers["access-control-allow-origin"], "http://127.0.0.1:43210");
  await app.close();
});


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


test("GET installed → DELETE → GET installed 为空", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-local-llm-route-cycle-"));
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
  const listBefore = await app.inject({
    method: "GET",
    url: "/local-llm/installed",
    remoteAddress: "127.0.0.1",
  });
  assert.equal(listBefore.statusCode, 200);
  const beforeBody = listBefore.json() as { models: Array<{ id: string }> };
  assert.equal(beforeBody.models.length, 1);
  assert.equal(beforeBody.models[0]?.id, modelId);
  const routePath = localLlmModelIdToRoutePath(modelId);
  const del = await app.inject({
    method: "DELETE",
    url: `/local-llm/installed/${routePath}`,
    remoteAddress: "127.0.0.1",
  });
  assert.equal(del.statusCode, 200);
  assert.equal(existsSync(modelDirPath), false);
  const listAfter = await app.inject({
    method: "GET",
    url: "/local-llm/installed",
    remoteAddress: "127.0.0.1",
  });
  assert.equal(listAfter.statusCode, 200);
  const afterBody = listAfter.json() as { models: unknown[] };
  assert.equal(afterBody.models.length, 0);
  await app.close();
});
