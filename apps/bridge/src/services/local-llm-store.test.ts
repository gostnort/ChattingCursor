import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getLocalLlmHfDownloadCacheDir, getLocalLlmInstallJobsDir } from "../paths.js";
import {
  addLocalLlmAuthor,
  buildLocalLlmHfSpawnEnv,
  buildLocalLlmModelId,
  cleanupModelDirAfterDownload,
  clearLocalLlmHfDownloadCache,
  deleteInstalledLocalLlmModel,
  encodeHfRepoId,
  finalizeLocalLlmInstall,
  listInstalledLocalLlmModels,
  listLocalLlmAuthors,
  localLlmModelIdToRoutePath,
  maybeMigrateLegacyGemma4Weights,
  modelSlugFromRepoId,
  normalizeLocalLlmModelId,
  parseLocalLlmRouteModelId,
  purgeNestedModelCachesUnderLocalLlm,
  verifyGgufFilenamesInDir,
} from "./local-llm-store.js";
import { resetInstallJobsForTest } from "./local-llm-install-jobs.js";


test("buildLocalLlmModelId 格式", () => {
  assert.equal(
    buildLocalLlmModelId("unsloth", "gemma-4-E4B-it-GGUF"),
    "local-llm/unsloth/gemma-4-E4B-it-GGUF",
  );
});


test("encodeHfRepoId 保留 author/model 斜杠", () => {
  assert.equal(encodeHfRepoId("unsloth/gemma-4-E4B-it-GGUF"), "unsloth/gemma-4-E4B-it-GGUF");
  assert.equal(encodeHfRepoId("unsloth/Qwen3.5-9B-GGUF"), "unsloth/Qwen3.5-9B-GGUF");
  assert.equal(encodeHfRepoId("org name/weird repo"), "org%20name/weird%20repo");
});


test("parseLocalLlmRouteModelId 与 localLlmModelIdToRoutePath 互逆", () => {
  const modelId = "local-llm/bartowski/google_gemma-4-26B-A4B-it-GGUF";
  const routePath = localLlmModelIdToRoutePath(modelId);
  assert.equal(routePath, "local-llm/bartowski/google_gemma-4-26B-A4B-it-GGUF");
  assert.equal(parseLocalLlmRouteModelId(routePath), modelId);
  assert.equal(parseLocalLlmRouteModelId(encodeURIComponent(modelId)), modelId);
});


test("normalizeLocalLlmModelId 补全 local-llm 前缀", () => {
  assert.equal(
    normalizeLocalLlmModelId("bartowski/google_gemma-4-26B-A4B-it-GGUF"),
    "local-llm/bartowski/google_gemma-4-26B-A4B-it-GGUF",
  );
  assert.equal(parseLocalLlmRouteModelId("bartowski/google_gemma-4-26B-A4B-it-GGUF"), "local-llm/bartowski/google_gemma-4-26B-A4B-it-GGUF");
});


test("cleanupModelDirAfterDownload 移除 .cache 与非 gguf 残留", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-local-llm-clean-"));
  t.after(async () => {
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  const cacheDir = path.join(tempDir, ".cache", "huggingface", "download");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, "blob.incomplete"), "partial");
  await writeFile(path.join(tempDir, "weights.gguf"), "weights");
  await writeFile(path.join(tempDir, "model.json"), "{}");
  await writeFile(path.join(tempDir, "README.md"), "junk");
  await writeFile(path.join(tempDir, "weights.gguf.lock"), "lock");
  await cleanupModelDirAfterDownload(tempDir);
  assert.equal(existsSync(path.join(tempDir, ".cache")), false);
  assert.equal(existsSync(path.join(tempDir, "README.md")), false);
  assert.equal(existsSync(path.join(tempDir, "weights.gguf.lock")), false);
  assert.equal(existsSync(path.join(tempDir, "weights.gguf")), true);
  assert.equal(existsSync(path.join(tempDir, "model.json")), true);
});


test("buildLocalLlmHfSpawnEnv 统一 HF 缓存环境变量", () => {
  const cacheDir = path.join(os.tmpdir(), "hf-unified-cache");
  const env = buildLocalLlmHfSpawnEnv("test-token", cacheDir);
  assert.equal(env.HF_HOME, cacheDir);
  assert.equal(env.HF_HUB_CACHE, path.join(cacheDir, "hub"));
  assert.equal(env.HUGGINGFACE_HUB_CACHE, path.join(cacheDir, "hub"));
  assert.equal(env.TRANSFORMERS_CACHE, path.join(cacheDir, "transformers"));
  assert.equal(env.XET_CACHE, path.join(cacheDir, "xet"));
  assert.equal(env.HF_TOKEN, "test-token");
});


test("purgeNestedModelCachesUnderLocalLlm 清除 author/model 下嵌套 .cache", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-local-llm-purge-"));
  const previous = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  t.after(async () => {
    process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previous ?? "";
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = tempDir;
  const modelDir = path.join(tempDir, "bartowski", "google_gemma-4-26B-A4B-it-GGUF");
  const nestedCache = path.join(modelDir, ".cache", "huggingface", "download");
  await mkdir(nestedCache, { recursive: true });
  await writeFile(path.join(nestedCache, "partial.bin"), "x");
  await writeFile(path.join(modelDir, "google_gemma-4-26B-A4B-it-Q4_K_M.gguf"), "weights");
  await writeFile(path.join(modelDir, "model.json"), "{}");
  await purgeNestedModelCachesUnderLocalLlm();
  assert.equal(existsSync(path.join(modelDir, ".cache")), false);
  assert.equal(existsSync(path.join(modelDir, "google_gemma-4-26B-A4B-it-Q4_K_M.gguf")), true);
  assert.equal(existsSync(path.join(modelDir, "model.json")), true);
});


test("deleteInstalledLocalLlmModel 删除模型目录与作者目录", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-local-llm-delete-"));
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
  await writeFile(path.join(modelDirPath, "test.gguf"), "x");
  await writeFile(path.join(modelDirPath, "model.json"), JSON.stringify({
    id: modelId,
    author,
    modelSlug,
    repoId: `${author}/${modelSlug}`,
    displayName: modelSlug,
    ggufGroupKey: "test",
    filenames: ["test.gguf"],
    defaultPrompt: "hi",
    installedAt: new Date().toISOString(),
  }));
  await writeFile(path.join(tempDir, "registry.json"), JSON.stringify({ savedAuthors: [author] }));
  await deleteInstalledLocalLlmModel(modelId);
  assert.equal(existsSync(modelDirPath), false);
  assert.equal(existsSync(path.join(tempDir, author)), false);
  const models = await listInstalledLocalLlmModels();
  assert.equal(models.length, 0);
  const registry = JSON.parse(await readFile(path.join(tempDir, "registry.json"), "utf8")) as { savedAuthors: string[] };
  assert.equal(registry.savedAuthors.includes(author), false);
});


test("deleteInstalledLocalLlmModel 接受无 local-llm 前缀的 id", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-local-llm-delete-raw-"));
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
  await writeFile(path.join(modelDirPath, "test.gguf"), "x");
  await writeFile(path.join(modelDirPath, "model.json"), JSON.stringify({
    id: modelId,
    author,
    modelSlug,
    repoId: `${author}/${modelSlug}`,
    displayName: modelSlug,
    ggufGroupKey: "test",
    filenames: ["test.gguf"],
    defaultPrompt: "hi",
    installedAt: new Date().toISOString(),
  }));
  await writeFile(path.join(tempDir, "registry.json"), JSON.stringify({ savedAuthors: [author] }));
  await deleteInstalledLocalLlmModel(`${author}/${modelSlug}`);
  assert.equal(existsSync(modelDirPath), false);
});


test("getLocalLlmHfDownloadCacheDir 使用 local_llm 下统一缓存目录", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-hf-cache-path-"));
  const previous = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  t.after(async () => {
    process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previous ?? "";
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = tempDir;
  assert.equal(getLocalLlmHfDownloadCacheDir(), path.join(tempDir, ".hf-download-cache"));
});


test("clearLocalLlmHfDownloadCache 删除整个 HF 下载缓存", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-hf-cache-clear-"));
  const previous = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  t.after(async () => {
    process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previous ?? "";
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = tempDir;
  const cacheDir = getLocalLlmHfDownloadCacheDir();
  const blobPath = path.join(cacheDir, "hub", "blob.bin");
  await mkdir(path.dirname(blobPath), { recursive: true });
  await writeFile(blobPath, "partial");
  await clearLocalLlmHfDownloadCache();
  assert.equal(existsSync(cacheDir), false);
});


test("listInstalledLocalLlmModels 扫描 model.json", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-local-llm-"));
  const previous = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  t.after(async () => {
    process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previous ?? "";
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = tempDir;
  const modelDir = path.join(tempDir, "unsloth", "gemma-4-E4B-it-GGUF");
  await import("node:fs/promises").then((fs) => fs.mkdir(modelDir, { recursive: true }));
  await writeFile(path.join(modelDir, "test.gguf"), "x");
  await writeFile(path.join(modelDir, "model.json"), JSON.stringify({
    id: "local-llm/unsloth/gemma-4-E4B-it-GGUF",
    author: "unsloth",
    modelSlug: "gemma-4-E4B-it-GGUF",
    repoId: "unsloth/gemma-4-E4B-it-GGUF",
    displayName: "gemma-4-E4B-it-GGUF",
    ggufGroupKey: "test",
    filenames: ["test.gguf"],
    defaultPrompt: "hi",
    installedAt: new Date().toISOString(),
  }));
  const models = await listInstalledLocalLlmModels();
  assert.equal(models.length, 1);
  assert.equal(`${models[0]?.author}/${models[0]?.modelSlug}`, "unsloth/gemma-4-E4B-it-GGUF");
  assert.equal(models[0]?.weightsReady, true);
});


test("getLocalLlmInstallJobsDir 不在 local_llm 作者扫描路径内", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cc-install-jobs-path-"));
  const previousRepo = process.env.CHATTINGCURSOR_REPO_ROOT;
  t.after(async () => {
    process.env.CHATTINGCURSOR_REPO_ROOT = previousRepo ?? "";
    await import("node:fs/promises").then((fs) => fs.rm(tempRoot, { recursive: true, force: true }));
  });
  process.env.CHATTINGCURSOR_REPO_ROOT = tempRoot;
  assert.equal(
    getLocalLlmInstallJobsDir(),
    path.join(tempRoot, ".chattingcursor", "local-llm-install-jobs"),
  );
});


test("listLocalLlmAuthors 排除 server、点目录与缓存/任务目录", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-local-llm-auth-filter-"));
  const previous = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  t.after(async () => {
    process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previous ?? "";
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = tempDir;
  await mkdir(path.join(tempDir, "server"), { recursive: true });
  await mkdir(path.join(tempDir, ".install-jobs"), { recursive: true });
  await mkdir(path.join(tempDir, ".hf-download-cache"), { recursive: true });
  await writeFile(path.join(tempDir, "registry.json"), JSON.stringify({
    savedAuthors: ["unsloth", ".install-jobs", "server"],
  }));
  const modelDir = path.join(tempDir, "unsloth", "gemma-4-E4B-it-GGUF");
  await mkdir(modelDir, { recursive: true });
  await writeFile(path.join(modelDir, "model.json"), JSON.stringify({
    id: "local-llm/unsloth/gemma-4-E4B-it-GGUF",
    author: "unsloth",
    modelSlug: "gemma-4-E4B-it-GGUF",
    repoId: "unsloth/gemma-4-E4B-it-GGUF",
    displayName: "gemma-4-E4B-it-GGUF",
    ggufGroupKey: "test",
    filenames: ["test.gguf"],
    defaultPrompt: "hi",
    installedAt: new Date().toISOString(),
  }));
  const authors = await listLocalLlmAuthors();
  assert.deepEqual(authors, ["unsloth"]);
});


test("addLocalLlmAuthor 写入 registry", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-local-llm-auth-"));
  const previous = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  t.after(async () => {
    process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previous ?? "";
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = tempDir;
  const authors = await addLocalLlmAuthor("google");
  assert.ok(authors.includes("google"));
  const registry = JSON.parse(await readFile(path.join(tempDir, "registry.json"), "utf8")) as { savedAuthors: string[] };
  assert.ok(registry.savedAuthors.includes("google"));
});


test("maybeMigrateLegacyGemma4Weights 迁移 Gemma4/llm_source", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cc-migrate-root-"));
  const previousRepo = process.env.CHATTINGCURSOR_REPO_ROOT;
  const previousLocal = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  t.after(async () => {
    process.env.CHATTINGCURSOR_REPO_ROOT = previousRepo ?? "";
    process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previousLocal ?? "";
    await import("node:fs/promises").then((fs) => fs.rm(tempRoot, { recursive: true, force: true }));
  });
  process.env.CHATTINGCURSOR_REPO_ROOT = tempRoot;
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = path.join(tempRoot, "local_llm");
  const legacyDir = path.join(tempRoot, "Gemma4", "llm_source");
  await import("node:fs/promises").then(async (fs) => {
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, "gemma-4-E4B-it-UD-Q8_K_XL.gguf"), "data");
  });
  const migrated = await maybeMigrateLegacyGemma4Weights();
  assert.equal(migrated, true);
  const models = await listInstalledLocalLlmModels();
  assert.equal(models.length, 1);
  assert.equal(models[0]?.author, "unsloth");
  assert.ok(await import("node:fs/promises").then((fs) => fs.access(path.join(models[0]!.dir, "gemma-4-E4B-it-UD-Q8_K_XL.gguf")).then(() => true).catch(() => false)));
});


test("verifyGgufFilenamesInDir 按 basename 匹配 Qwen GGUF", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-qwen-verify-"));
  t.after(async () => {
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  await writeFile(path.join(tempDir, "Qwen3.5-9B-Q8_0.gguf"), "weights");
  const ready = await verifyGgufFilenamesInDir(tempDir, ["Qwen3.5-9B-Q8_0.gguf"]);
  assert.equal(ready, true);
  const missing = await verifyGgufFilenamesInDir(tempDir, ["Qwen3.5-9B-Q4_K_M.gguf"]);
  assert.equal(missing, false);
});


test("finalizeLocalLlmInstall 写入 model.json 后出现在已安装列表", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-qwen-finalize-"));
  const previous = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  t.after(async () => {
    process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previous ?? "";
    resetInstallJobsForTest();
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = tempDir;
  resetInstallJobsForTest();
  const author = "unsloth";
  const repoId = "unsloth/Qwen3.5-9B-GGUF";
  const modelSlug = modelSlugFromRepoId(repoId);
  const targetDir = path.join(tempDir, author, modelSlug);
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(targetDir, "Qwen3.5-9B-Q8_0.gguf"), "weights");
  const nestedCache = path.join(targetDir, ".cache", "huggingface", "download");
  await mkdir(nestedCache, { recursive: true });
  await writeFile(path.join(nestedCache, "stale.bin"), "partial");
  const jobId = "install-test-qwen-finalize";
  const installed = await finalizeLocalLlmInstall(
    jobId,
    {
      author,
      repoId,
      ggufGroupKey: "Qwen3.5-9B-Q8_0",
      filenames: ["Qwen3.5-9B-Q8_0.gguf"],
      displayName: "Qwen3.5-9B-GGUF",
    },
    targetDir,
    null,
  );
  assert.equal(installed.id, buildLocalLlmModelId(author, modelSlug));
  assert.equal(installed.weightsReady, true);
  const models = await listInstalledLocalLlmModels();
  assert.equal(models.length, 1);
  assert.equal(models[0]?.repoId, repoId);
  assert.equal(models[0]?.modelSlug, modelSlug);
  assert.equal(existsSync(path.join(targetDir, ".cache")), false);
});


test("listInstalledLocalLlmModels 读取带 UTF-8 BOM 的 model.json", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-local-llm-bom-"));
  const previous = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  t.after(async () => {
    process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previous ?? "";
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = tempDir;
  const author = "test-delete-tmp";
  const modelSlug = "throwaway-model";
  const modelId = buildLocalLlmModelId(author, modelSlug);
  const modelDirPath = path.join(tempDir, author, modelSlug);
  await mkdir(modelDirPath, { recursive: true });
  await writeFile(path.join(modelDirPath, "weights.gguf"), "data");
  const manifest = JSON.stringify({
    id: modelId,
    author,
    modelSlug,
    repoId: `${author}/${modelSlug}`,
    displayName: modelSlug,
    ggufGroupKey: "test",
    filenames: ["weights.gguf"],
    defaultPrompt: "test",
    installedAt: new Date().toISOString(),
  });
  await writeFile(path.join(modelDirPath, "model.json"), `\uFEFF${manifest}`);
  const authors = await listLocalLlmAuthors();
  assert.ok(authors.includes(author));
  const models = await listInstalledLocalLlmModels();
  assert.equal(models.length, 1);
  assert.equal(models[0]?.id, modelId);
  await deleteInstalledLocalLlmModel(modelId);
  assert.equal(existsSync(modelDirPath), false);
});
