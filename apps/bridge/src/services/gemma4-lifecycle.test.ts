import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  buildLocalLlmServerEnv,
  ensureLocalLlmReady,
  ensureLocalLlmSidecarStarted,
  inspectLocalLlmWeights,
  isLocalLlmManaged,
  preflightLocalLlmModel,
  probeLocalLlmLoadState,
  resolveLocalLlmApiBaseUrl,
  resolveLocalLlmServerLaunch,
  resolveLlamaRuntimePathEntries,
  setLocalLlmSpawnRunnerForTests,
  stopManagedLocalLlm,
  triggerLocalLlmModelLoad,
} from "./local-llm-lifecycle.js";
import { getLocalLlmServerScriptPath } from "../paths.js";
import { buildLocalLlmModelId } from "./local-llm-store.js";


async function seedInstalledModel(root: string): Promise<string> {
  const modelId = buildLocalLlmModelId("unsloth", "gemma-4-E4B-it-GGUF");
  const modelDir = path.join(root, "unsloth", "gemma-4-E4B-it-GGUF");
  await import("node:fs/promises").then(async (fs) => {
    await fs.mkdir(modelDir, { recursive: true });
    await fs.writeFile(path.join(modelDir, "gemma-4-E4B-it-UD-Q8_K_XL.gguf"), "");
    await fs.writeFile(path.join(modelDir, "model.json"), JSON.stringify({
      id: modelId,
      author: "unsloth",
      modelSlug: "gemma-4-E4B-it-GGUF",
      repoId: "unsloth/gemma-4-E4B-it-GGUF",
      displayName: "gemma-4-E4B-it-GGUF",
      ggufGroupKey: "gemma-4-E4B-it-UD-Q8_K_XL",
      filenames: ["gemma-4-E4B-it-UD-Q8_K_XL.gguf"],
      defaultPrompt: "test",
      installedAt: new Date().toISOString(),
    }));
  });
  return modelId;
}


test("local-llm 托管默认开启，可关闭", () => {
  const previous = process.env.LOCAL_LLM_MANAGED;
  process.env.LOCAL_LLM_MANAGED = "";
  assert.equal(isLocalLlmManaged(), true);
  process.env.LOCAL_LLM_MANAGED = "0";
  assert.equal(isLocalLlmManaged(), false);
  process.env.LOCAL_LLM_MANAGED = previous ?? "";
});


test("resolveLocalLlmApiBaseUrl 默认端口 4322", () => {
  const previousPort = process.env.LOCAL_LLM_PORT;
  const previousManaged = process.env.LOCAL_LLM_MANAGED;
  const previousBase = process.env.LOCAL_LLM_API_BASE_URL;
  process.env.LOCAL_LLM_MANAGED = "1";
  delete process.env.LOCAL_LLM_API_BASE_URL;
  delete process.env.LOCAL_LLM_PORT;
  assert.equal(resolveLocalLlmApiBaseUrl(), "http://127.0.0.1:4322/v1");
  process.env.LOCAL_LLM_PORT = previousPort ?? "";
  process.env.LOCAL_LLM_MANAGED = previousManaged ?? "";
  process.env.LOCAL_LLM_API_BASE_URL = previousBase ?? "";
});


test("inspectLocalLlmWeights 识别 GGUF 就绪与缺失", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-local-llm-w-"));
  t.after(async () => {
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  assert.equal(await inspectLocalLlmWeights(tempDir, []), "missing");
  await writeFile(path.join(tempDir, "test.gguf"), "");
  assert.equal(await inspectLocalLlmWeights(tempDir, ["test.gguf"]), "ready");
});


test("resolveLocalLlmServerLaunch 默认启动 llm_server.py", () => {
  const launch = resolveLocalLlmServerLaunch();
  const script = getLocalLlmServerScriptPath();
  assert.ok(script.endsWith("llm_server.py"));
  assert.equal(launch.args[launch.args.length - 1], script);
});


test("buildLocalLlmServerEnv 传递权重目录与模型 id", () => {
  const env = buildLocalLlmServerEnv({
    modelDir: "/tmp/local",
    modelId: "local-llm/unsloth/test",
    host: "127.0.0.1",
    port: 8000,
  });
  assert.equal(env.LOCAL_LLM_WEIGHTS_DIR, "/tmp/local");
  assert.equal(env.LOCAL_LLM_MODEL_ID, "local-llm/unsloth/test");
  assert.equal(env.LOCAL_LLM_DEFER_MODEL_LOAD, "1");
  assert.equal(env.GEMMA4_WEIGHTS_DIR, "/tmp/local");
  assert.equal(env.LOCAL_LLM_N_GPU_LAYERS, undefined);
});


test("resolveLlamaRuntimePathEntries 拼接 venv CUDA DLL 目录", () => {
  const repoRoot = path.resolve(path.join(path.dirname(getLocalLlmServerScriptPath()), "..", ".."));
  const fakePython = path.join(repoRoot, ".venv", "Scripts", "python.exe");
  const entries = resolveLlamaRuntimePathEntries(fakePython);
  if (process.platform === "win32") {
    const sitePackages = path.join(repoRoot, ".venv", "Lib", "site-packages");
    for (const suffix of ["nvidia/cublas/bin", "nvidia/cuda_runtime/bin", "bin"]) {
      const candidate = path.join(sitePackages, ...suffix.split("/"));
      if (existsSync(candidate)) {
        assert.ok(entries.includes(candidate));
      }
    }
  }
});


test("ensureLocalLlmSidecarStarted 在托管模式下拉起子进程", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-local-llm-spawn-"));
  const previousDir = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  const previousManaged = process.env.LOCAL_LLM_MANAGED;
  const previousPort = process.env.LOCAL_LLM_PORT;
  const previousTimeout = process.env.LOCAL_LLM_SIDECAR_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;
  let spawnCount = 0;
  let healthChecks = 0;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    setLocalLlmSpawnRunnerForTests(null);
    await stopManagedLocalLlm();
    process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previousDir ?? "";
    process.env.LOCAL_LLM_MANAGED = previousManaged ?? "";
    process.env.LOCAL_LLM_PORT = previousPort ?? "";
    process.env.LOCAL_LLM_SIDECAR_TIMEOUT_MS = previousTimeout ?? "";
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = tempDir;
  process.env.LOCAL_LLM_MANAGED = "1";
  process.env.LOCAL_LLM_PORT = "18080";
  process.env.LOCAL_LLM_SIDECAR_TIMEOUT_MS = "8000";
  const modelId = await seedInstalledModel(tempDir);
  setLocalLlmSpawnRunnerForTests(() => {
    spawnCount += 1;
    const child = new EventEmitter() as import("node:child_process").ChildProcess;
    Object.defineProperty(child, "exitCode", { value: null, writable: true });
    child.kill = () => {
      Object.defineProperty(child, "exitCode", { value: 0, writable: true });
      child.emit("exit", 0, null);
      return true;
    };
    return child;
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/v1/health")) {
      healthChecks += 1;
      if (healthChecks >= 2) {
        return new Response(JSON.stringify({ status: "idle" }), { status: 200 });
      }
      throw new Error("connection refused");
    }
    return originalFetch(input);
  };
  await ensureLocalLlmSidecarStarted(modelId);
  assert.equal(spawnCount, 1);
  assert.ok(healthChecks >= 2);
});


test("ensureLocalLlmReady 在 idle 后触发 /load 并等待 ready", async (t) => {
  await stopManagedLocalLlm();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-local-llm-ready-"));
  const previousDir = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  const previousManaged = process.env.LOCAL_LLM_MANAGED;
  const previousPort = process.env.LOCAL_LLM_PORT;
  const previousTimeout = process.env.LOCAL_LLM_STARTUP_TIMEOUT_MS;
  const previousSidecarTimeout = process.env.LOCAL_LLM_SIDECAR_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;
  let spawnCount = 0;
  let healthChecks = 0;
  let loadPosts = 0;
  let spawnedArgs: string[] = [];
  t.after(async () => {
    globalThis.fetch = originalFetch;
    setLocalLlmSpawnRunnerForTests(null);
    await stopManagedLocalLlm();
    process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previousDir ?? "";
    process.env.LOCAL_LLM_MANAGED = previousManaged ?? "";
    process.env.LOCAL_LLM_PORT = previousPort ?? "";
    process.env.LOCAL_LLM_STARTUP_TIMEOUT_MS = previousTimeout ?? "";
    process.env.LOCAL_LLM_SIDECAR_TIMEOUT_MS = previousSidecarTimeout ?? "";
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = tempDir;
  process.env.LOCAL_LLM_MANAGED = "1";
  process.env.LOCAL_LLM_PORT = "18080";
  process.env.LOCAL_LLM_STARTUP_TIMEOUT_MS = "8000";
  process.env.LOCAL_LLM_SIDECAR_TIMEOUT_MS = "8000";
  const modelId = await seedInstalledModel(tempDir);
  setLocalLlmSpawnRunnerForTests((_command, args) => {
    spawnCount += 1;
    spawnedArgs = args;
    const child = new EventEmitter() as import("node:child_process").ChildProcess;
    Object.defineProperty(child, "exitCode", { value: null, writable: true });
    child.kill = () => {
      Object.defineProperty(child, "exitCode", { value: 0, writable: true });
      child.emit("exit", 0, null);
      return true;
    };
    return child;
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/load") && init?.method === "POST") {
      loadPosts += 1;
      return new Response(JSON.stringify({ status: "loading" }), { status: 200 });
    }
    if (url.includes("/v1/health")) {
      healthChecks += 1;
      if (spawnCount < 1) {
        throw new Error("connection refused");
      }
      if (loadPosts < 1) {
        return new Response(JSON.stringify({ status: "idle", gguf_gb: "8.1", mode: "gpu" }), { status: 200 });
      }
      if (healthChecks < 6) {
        return new Response(JSON.stringify({
          status: "loading",
          mode: "mixed",
          n_gpu_layers: "35",
          load_elapsed_sec: "2",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "ready", mode: "mixed" }), { status: 200 });
    }
    return originalFetch(input, init);
  };
  await ensureLocalLlmReady(modelId);
  assert.ok(spawnCount >= 1);
  assert.equal(loadPosts, 1);
  assert.ok(healthChecks >= 4);
  assert.ok(spawnedArgs.some((arg) => arg.includes("llm_server.py")));
});


test("preflightLocalLlmModel 识别 GGUF 体积", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-local-llm-pf-"));
  const previousDir = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  t.after(async () => {
    process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previousDir ?? "";
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = tempDir;
  const modelId = await seedInstalledModel(tempDir);
  const result = await preflightLocalLlmModel(modelId);
  assert.equal(result.ggufGb, 0);
  assert.equal(result.mixedMode, false);
});


test("ensureLocalLlmReady 在 sidecar 报错时抛出中文错误", async (t) => {
  await stopManagedLocalLlm();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-local-llm-err-"));
  const previousDir = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  const previousManaged = process.env.LOCAL_LLM_MANAGED;
  const previousPort = process.env.LOCAL_LLM_PORT;
  const previousTimeout = process.env.LOCAL_LLM_STARTUP_TIMEOUT_MS;
  const previousSidecarTimeout = process.env.LOCAL_LLM_SIDECAR_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    setLocalLlmSpawnRunnerForTests(null);
    await stopManagedLocalLlm();
    process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previousDir ?? "";
    process.env.LOCAL_LLM_MANAGED = previousManaged ?? "";
    process.env.LOCAL_LLM_PORT = previousPort ?? "";
    process.env.LOCAL_LLM_STARTUP_TIMEOUT_MS = previousTimeout ?? "";
    process.env.LOCAL_LLM_SIDECAR_TIMEOUT_MS = previousSidecarTimeout ?? "";
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  });
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = tempDir;
  process.env.LOCAL_LLM_MANAGED = "1";
  process.env.LOCAL_LLM_PORT = "18081";
  process.env.LOCAL_LLM_STARTUP_TIMEOUT_MS = "4000";
  process.env.LOCAL_LLM_SIDECAR_TIMEOUT_MS = "4000";
  const modelId = await seedInstalledModel(tempDir);
  setLocalLlmSpawnRunnerForTests(() => {
    const child = new EventEmitter() as import("node:child_process").ChildProcess;
    Object.defineProperty(child, "exitCode", { value: null, writable: true });
    child.kill = () => {
      Object.defineProperty(child, "exitCode", { value: 0, writable: true });
      child.emit("exit", 0, null);
      return true;
    };
    return child;
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/load") && init?.method === "POST") {
      return new Response(JSON.stringify({ status: "error", detail: "未在 /weights 找到 *.gguf 权重" }), { status: 200 });
    }
    if (url.includes("/v1/health")) {
      return new Response(JSON.stringify({
        status: "error",
        detail: "未在 /weights 找到 *.gguf 权重",
      }), { status: 200 });
    }
    return originalFetch(input, init);
  };
  await assert.rejects(
    () => ensureLocalLlmReady(modelId),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /权重|gguf/i);
      return true;
    },
  );
});


test("triggerLocalLlmModelLoad 在 ready 时 no-op", async (t) => {
  const originalFetch = globalThis.fetch;
  let loadPosts = 0;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/health")) {
      return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
    }
    if (url.includes("/v1/load")) {
      loadPosts += 1;
    }
    return originalFetch(input, init);
  };
  await triggerLocalLlmModelLoad("http://127.0.0.1:4322/v1");
  assert.equal(loadPosts, 0);
  const probe = await probeLocalLlmLoadState("http://127.0.0.1:4322/v1");
  assert.equal(probe.state, "ready");
});
