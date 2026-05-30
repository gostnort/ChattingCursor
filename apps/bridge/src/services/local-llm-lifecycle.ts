import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { getLocalLlmServerScriptPath, getRepoRootDir } from "../paths.js";
import { findInstalledLocalLlmModel, inspectModelWeightsReady } from "./local-llm-store.js";


export type LocalLlmWeightsStatus = "ready" | "missing" | "incomplete";


export type LocalLlmLoadState = "down" | "idle" | "loading" | "ready" | "error";


export type LocalLlmHealthStatus = {
  managed: boolean;
  baseUrl: string;
  weights: LocalLlmWeightsStatus;
  modelDir: string;
  modelId?: string;
  running: boolean;
  spawning: boolean;
  loadState: LocalLlmLoadState;
  loadError?: string;
  message?: string;
};


type SpawnRunner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;


const DEFAULT_PORT = 4322;
const DEFAULT_HOST = "127.0.0.1";
const README_HINT = "请在「本地 → 本地模型」安装 GGUF 权重，或运行 local_llm/server/install.bat";


let managedChild: ChildProcess | null = null;
let spawnPromise: Promise<void> | null = null;
let spawnRunner: SpawnRunner = (command, args, options) => spawn(command, args, options);
let cachedPython: string | null = null;
let lastSpawnStderr = "";
let activeModelId: string | null = null;


/** 测试注入：替换子进程启动函数 */
export function setLocalLlmSpawnRunnerForTests(runner: SpawnRunner | null): void {
  spawnRunner = runner ?? ((command, args, options) => spawn(command, args, options));
}


/** 兼容 Gemma4 测试别名 */
export const setGemma4SpawnRunnerForTests = setLocalLlmSpawnRunnerForTests;


function readEnv(name: string, legacy?: string): string {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }
  if (legacy) {
    return process.env[legacy]?.trim() ?? "";
  }
  return "";
}


/** 是否由 Bridge 托管启动推理 sidecar（默认开启） */
export function isLocalLlmManaged(): boolean {
  const flag = readEnv("LOCAL_LLM_MANAGED", "GEMMA4_MANAGED");
  if (flag === "0" || flag.toLowerCase() === "false") {
    return false;
  }
  return true;
}


export const isGemma4Managed = isLocalLlmManaged;


/** 解析 OpenAI 兼容 API 根路径（含 /v1） */
export function resolveLocalLlmApiBaseUrl(): string {
  const custom = readEnv("LOCAL_LLM_API_BASE_URL", "GEMMA4_API_BASE_URL");
  if (custom && !isLocalLlmManaged()) {
    return custom.replace(/\/$/, "");
  }
  const host = readEnv("LOCAL_LLM_HOST", "GEMMA4_HOST") || DEFAULT_HOST;
  const port = Number(readEnv("LOCAL_LLM_PORT", "GEMMA4_PORT") || DEFAULT_PORT);
  return `http://${host}:${port}/v1`;
}


export const resolveGemma4ApiBaseUrl = resolveLocalLlmApiBaseUrl;


function resolveHostPort(): { host: string; port: number } {
  const base = resolveLocalLlmApiBaseUrl();
  try {
    const url = new URL(base);
    return {
      host: url.hostname || DEFAULT_HOST,
      port: Number(url.port || DEFAULT_PORT),
    };
  } catch {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT };
  }
}


/** 检测权重目录 */
export async function inspectLocalLlmWeights(modelDir: string, filenames: string[]): Promise<LocalLlmWeightsStatus> {
  let names: string[] = [];
  try {
    names = await readdir(modelDir);
  } catch {
    return "missing";
  }
  const ggufFiles = names.filter((name) => name.toLowerCase().endsWith(".gguf"));
  if (ggufFiles.length === 0) {
    return "missing";
  }
  if (filenames.length === 0) {
    return ggufFiles.length === 1 ? "ready" : "ready";
  }
  const ready = await inspectModelWeightsReady(modelDir, filenames);
  return ready ? "ready" : "incomplete";
}


export async function inspectGemma4Weights(modelDir?: string): Promise<LocalLlmWeightsStatus> {
  if (!modelDir) {
    return "missing";
  }
  return inspectLocalLlmWeights(modelDir, []);
}


/** 探测 sidecar 加载阶段 */
export async function probeLocalLlmLoadState(
  baseUrl = resolveLocalLlmApiBaseUrl(),
): Promise<{ state: LocalLlmLoadState; detail?: string }> {
  const root = baseUrl.replace(/\/$/, "");
  try {
    const response = await fetch(`${root}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      return { state: "down" };
    }
    const body = (await response.json()) as { status?: string; detail?: string };
    if (body.status === "ready") {
      return { state: "ready" };
    }
    if (body.status === "idle") {
      return { state: "idle" };
    }
    if (body.status === "error") {
      return { state: "error", detail: body.detail?.trim() || "本地模型加载失败" };
    }
    if (body.status === "loading") {
      return { state: "loading" };
    }
    return { state: "down" };
  } catch {
    return { state: "down" };
  }
}


export const probeGemma4LoadState = probeLocalLlmLoadState;


export async function probeLocalLlmApiHealth(baseUrl = resolveLocalLlmApiBaseUrl()): Promise<boolean> {
  const probe = await probeLocalLlmLoadState(baseUrl);
  return probe.state === "ready";
}


export const probeGemma4ApiHealth = probeLocalLlmApiHealth;


function pythonHasInferenceDeps(executable: string): boolean {
  if (executable.includes(path.sep) && !existsSync(executable)) {
    return false;
  }
  const probe = spawnSync(
    executable,
    ["-c", "import llama_cpp, fastapi, uvicorn"],
    { timeout: 30_000, windowsHide: true, encoding: "utf8" },
  );
  return probe.status === 0;
}


/** 解析 Python 可执行文件 */
export function resolveLocalLlmPythonExecutable(): string {
  const fromEnv = readEnv("LOCAL_LLM_PYTHON", "GEMMA4_PYTHON");
  if (fromEnv) {
    return fromEnv;
  }
  if (cachedPython) {
    return cachedPython;
  }
  const repoRoot = getRepoRootDir();
  const candidates = [
    path.join(repoRoot, ".venv", "Scripts", "python.exe"),
    path.join(repoRoot, ".venv", "bin", "python3"),
    path.join(repoRoot, ".venv", "bin", "python"),
    process.platform === "win32" ? "python" : "python3",
  ];
  for (const candidate of candidates) {
    if (pythonHasInferenceDeps(candidate)) {
      cachedPython = candidate;
      return candidate;
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}


export const resolveGemma4PythonExecutable = resolveLocalLlmPythonExecutable;


/** 解析 sidecar 启动命令 */
export function resolveLocalLlmServerLaunch(): { command: string; args: string[] } {
  const executable = readEnv("LOCAL_LLM_SERVER_EXECUTABLE", "GEMMA4_SERVER_EXECUTABLE");
  if (executable) {
    const parts = executable.split(/\s+/).filter(Boolean);
    return { command: parts[0] ?? resolveLocalLlmPythonExecutable(), args: parts.slice(1) };
  }
  return {
    command: resolveLocalLlmPythonExecutable(),
    args: [getLocalLlmServerScriptPath()],
  };
}


export const resolveGemma4ServerLaunch = resolveLocalLlmServerLaunch;


/** 为 sidecar 子进程合并环境变量 */
export function buildLocalLlmServerEnv(options: {
  modelDir: string;
  modelId: string;
  host: string;
  port: number;
}): NodeJS.ProcessEnv {
  const nCtx = readEnv("LOCAL_LLM_N_CTX", "GEMMA4_N_CTX") || "8192";
  const nGpuLayers = readEnv("LOCAL_LLM_N_GPU_LAYERS", "GEMMA4_N_GPU_LAYERS") || "-1";
  const maxNew = readEnv("LOCAL_LLM_MAX_NEW_TOKENS", "GEMMA4_MAX_NEW_TOKENS") || "1024";
  const deferLoad = readEnv("LOCAL_LLM_DEFER_MODEL_LOAD", "GEMMA4_DEFER_MODEL_LOAD") || "1";
  return {
    ...process.env,
    LOCAL_LLM_WEIGHTS_DIR: options.modelDir,
    LOCAL_LLM_MODEL_ID: options.modelId,
    LOCAL_LLM_HOST: options.host,
    LOCAL_LLM_PORT: String(options.port),
    LOCAL_LLM_N_CTX: nCtx,
    LOCAL_LLM_N_GPU_LAYERS: nGpuLayers,
    LOCAL_LLM_MAX_NEW_TOKENS: maxNew,
    LOCAL_LLM_DEFER_MODEL_LOAD: deferLoad,
    GEMMA4_WEIGHTS_DIR: options.modelDir,
    GEMMA4_MODEL_ID: options.modelId,
    GEMMA4_HOST: options.host,
    GEMMA4_PORT: String(options.port),
    GEMMA4_N_CTX: nCtx,
    GEMMA4_N_GPU_LAYERS: nGpuLayers,
    GEMMA4_MAX_NEW_TOKENS: maxNew,
    GEMMA4_DEFER_MODEL_LOAD: deferLoad,
  };
}


export function buildGemma4ServerEnv(modelDir: string, host: string, port: number): NodeJS.ProcessEnv {
  const modelId = readEnv("GEMMA4_MODEL_ID") || "local-llm";
  return buildLocalLlmServerEnv({ modelDir, modelId, host, port });
}


function resolveSidecarTimeoutMs(): number {
  const raw = readEnv("LOCAL_LLM_SIDECAR_TIMEOUT_MS", "GEMMA4_SIDECAR_TIMEOUT_MS");
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 120_000;
}


function resolveModelLoadTimeoutMs(): number {
  const raw = readEnv("LOCAL_LLM_STARTUP_TIMEOUT_MS", "GEMMA4_STARTUP_TIMEOUT_MS");
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 600_000;
}


function formatSpawnExitError(exitCode: number | null): Error {
  const tail = lastSpawnStderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-10)
    .join("\n");
  const hint = "请确认已执行 pip install -r local_llm/server/requirements-inference.txt。";
  const codeText = exitCode === null ? "未知" : String(exitCode);
  if (tail) {
    return new Error(`本地推理进程已退出（code ${codeText}）。\n${tail}\n${hint}`);
  }
  return new Error(`本地推理进程已退出（code ${codeText}）。${hint}`);
}


async function waitForSidecarHttp(timeoutMs: number): Promise<void> {
  const baseUrl = resolveLocalLlmApiBaseUrl();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await probeLocalLlmLoadState(baseUrl);
    if (probe.state !== "down") {
      return;
    }
    if (managedChild && managedChild.exitCode !== null) {
      throw formatSpawnExitError(managedChild.exitCode);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `本地推理进程在 ${Math.round(timeoutMs / 1000)} 秒内未响应 /v1/health。可增大 LOCAL_LLM_SIDECAR_TIMEOUT_MS。`,
  );
}


async function waitForModelReady(timeoutMs: number): Promise<void> {
  const baseUrl = resolveLocalLlmApiBaseUrl();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await probeLocalLlmLoadState(baseUrl);
    if (probe.state === "ready") {
      return;
    }
    if (probe.state === "error") {
      throw new Error(probe.detail ?? "本地模型加载失败");
    }
    if (managedChild && managedChild.exitCode !== null) {
      throw formatSpawnExitError(managedChild.exitCode);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `本地模型在 ${Math.round(timeoutMs / 1000)} 秒内未加载完成。可增大 LOCAL_LLM_STARTUP_TIMEOUT_MS。`,
  );
}


async function spawnManagedServer(modelId: string): Promise<void> {
  const model = await findInstalledLocalLlmModel(modelId);
  if (!model) {
    throw new Error(`未找到已安装本地模型：${modelId}`);
  }
  const weights = await inspectLocalLlmWeights(model.dir, model.filenames);
  if (weights !== "ready") {
    throw new Error(`本地模型权重不完整（${model.dir}）。${README_HINT}`);
  }
  if (managedChild && managedChild.exitCode === null && activeModelId === modelId) {
    await waitForSidecarHttp(resolveSidecarTimeoutMs());
    return;
  }
  if (managedChild && managedChild.exitCode === null) {
    await stopManagedLocalLlm();
  }
  activeModelId = modelId;
  const { host, port } = resolveHostPort();
  const launch = resolveLocalLlmServerLaunch();
  const logPath = readEnv("LOCAL_LLM_LOG_PATH", "GEMMA4_LOG_PATH");
  lastSpawnStderr = "";
  const child = spawnRunner(launch.command, launch.args, {
    cwd: path.dirname(getLocalLlmServerScriptPath()),
    env: buildLocalLlmServerEnv({ modelDir: model.dir, modelId: model.id, host, port }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  managedChild = child;
  const appendStderr = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    lastSpawnStderr = `${lastSpawnStderr}${text}`.slice(-32_000);
  };
  child.stderr?.on("data", appendStderr);
  if (logPath) {
    const { createWriteStream } = await import("node:fs");
    const logStream = createWriteStream(logPath, { flags: "a" });
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);
  }
  child.on("exit", () => {
    if (managedChild === child) {
      managedChild = null;
      activeModelId = null;
    }
  });
  await waitForSidecarHttp(resolveSidecarTimeoutMs());
}


/** 确保 sidecar 进程已启动（不等待 GGUF 加载） */
export async function ensureLocalLlmSidecarStarted(modelId: string): Promise<void> {
  const baseUrl = resolveLocalLlmApiBaseUrl();
  const probe = await probeLocalLlmLoadState(baseUrl);
  if (probe.state !== "down" && activeModelId === modelId) {
    return;
  }
  if (!isLocalLlmManaged()) {
    throw new Error(
      `本地 LLM API 未响应（${baseUrl}）。托管已关闭（LOCAL_LLM_MANAGED=0），请自行启动推理服务。`,
    );
  }
  if (!spawnPromise) {
    spawnPromise = spawnManagedServer(modelId).finally(() => {
      spawnPromise = null;
    });
  }
  await spawnPromise;
}


export async function ensureGemma4SidecarStarted(): Promise<void> {
  const { listInstalledLocalLlmModels } = await import("./local-llm-store.js");
  const models = await listInstalledLocalLlmModels();
  const first = models.find((item) => item.weightsReady);
  if (!first) {
    throw new Error(`未找到可用本地模型权重。${README_HINT}`);
  }
  await ensureLocalLlmSidecarStarted(first.id);
}


/** 确保模型已加载完成 */
export async function ensureLocalLlmReady(modelId: string): Promise<void> {
  const baseUrl = resolveLocalLlmApiBaseUrl();
  if (activeModelId === modelId && await probeLocalLlmApiHealth(baseUrl)) {
    return;
  }
  await ensureLocalLlmSidecarStarted(modelId);
  await waitForModelReady(resolveModelLoadTimeoutMs());
}


export async function ensureGemma4Ready(): Promise<void> {
  const { listInstalledLocalLlmModels } = await import("./local-llm-store.js");
  const models = await listInstalledLocalLlmModels();
  const first = models.find((item) => item.weightsReady);
  if (!first) {
    throw new Error(`未找到可用本地模型权重。${README_HINT}`);
  }
  await ensureLocalLlmReady(first.id);
}


/** Bridge 退出时停止托管子进程 */
export async function stopManagedLocalLlm(): Promise<void> {
  const child = managedChild;
  managedChild = null;
  activeModelId = null;
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}


/** 强制结束占用 sidecar 端口的进程（含 Bridge 未跟踪的外部启动） */
function killProcessListeningOnPort(port: number): boolean {
  if (process.platform === "win32") {
    const netstat = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
    const portToken = `:${port}`;
    const pids = new Set<string>();
    for (const line of netstat.stdout.split(/\r?\n/)) {
      if (!line.includes("LISTENING") || !line.includes(portToken)) {
        continue;
      }
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid) && pid !== "0") {
        pids.add(pid);
      }
    }
    let killed = false;
    for (const pid of pids) {
      const result = spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { windowsHide: true });
      if (result.status === 0) {
        killed = true;
      }
    }
    return killed;
  }
  const fuserKill = spawnSync("fuser", ["-k", `${port}/tcp`], { encoding: "utf8" });
  if (fuserKill.status === 0) {
    return true;
  }
  const lsof = spawnSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  const pids = lsof.stdout.trim().split(/\s+/).filter(Boolean);
  if (pids.length === 0) {
    return false;
  }
  for (const pid of pids) {
    spawnSync("kill", ["-TERM", pid]);
  }
  return true;
}


/** 删除模型前：停止托管 sidecar 并清理端口占用，Windows 额外等待文件锁释放 */
export async function forceStopLocalLlmSidecar(): Promise<{ unloaded: boolean }> {
  const hadManaged = managedChild !== null && managedChild.exitCode === null;
  await stopManagedLocalLlm();
  const { port } = resolveHostPort();
  const killedPort = killProcessListeningOnPort(port);
  const unloaded = hadManaged || killedPort;
  if (unloaded) {
    const waitMs = process.platform === "win32" ? 1500 : 500;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return { unloaded };
}


export const stopManagedGemma4 = stopManagedLocalLlm;


/** 若指定模型正在 sidecar 中加载则停止 */
export async function stopLocalLlmIfLoaded(modelId: string): Promise<void> {
  if (activeModelId === modelId) {
    await stopManagedLocalLlm();
  }
}


/** 汇总健康状态 */
export async function getLocalLlmHealthStatus(modelId?: string): Promise<LocalLlmHealthStatus> {
  const managed = isLocalLlmManaged();
  const baseUrl = resolveLocalLlmApiBaseUrl();
  let modelDir = "";
  let weights: LocalLlmWeightsStatus = "missing";
  if (modelId) {
    const model = await findInstalledLocalLlmModel(modelId);
    if (model) {
      modelDir = model.dir;
      weights = await inspectLocalLlmWeights(model.dir, model.filenames);
    }
  }
  const probe = await probeLocalLlmLoadState(baseUrl);
  const running = probe.state === "ready" && (!modelId || activeModelId === modelId);
  const loadError = probe.state === "error" ? probe.detail : undefined;
  let message: string | undefined;
  if (loadError) {
    message = loadError;
  } else if (running) {
    message = undefined;
  } else if (weights !== "ready") {
    message = README_HINT;
  } else if (probe.state === "idle") {
    message = "推理 sidecar 已就绪；发送首条消息时将加载模型权重。";
  } else if (probe.state === "loading" || spawnPromise !== null) {
    message = "正在加载 GGUF 到内存/GPU，首次对话可能需数十秒…";
  } else if (managed) {
    message = "推理服务未运行；选择本地模型后将自动预热 sidecar。";
  } else {
    message = "推理服务未运行，且托管模式已关闭。";
  }
  return {
    managed,
    baseUrl,
    weights,
    modelDir,
    modelId: modelId ?? activeModelId ?? undefined,
    running,
    spawning: spawnPromise !== null,
    loadState: probe.state,
    loadError,
    message,
  };
}


export async function getGemma4HealthStatus(): Promise<LocalLlmHealthStatus> {
  return getLocalLlmHealthStatus(activeModelId ?? undefined);
}


/** Bridge 启动时可选预热 */
export async function maybeWarmLocalLlmOnBridgeStart(): Promise<void> {
  const flag = readEnv("LOCAL_LLM_AUTO_START_ON_BRIDGE", "GEMMA4_AUTO_START_ON_BRIDGE");
  if (flag !== "1" && flag?.toLowerCase() !== "true") {
    return;
  }
  const { listInstalledLocalLlmModels } = await import("./local-llm-store.js");
  const models = await listInstalledLocalLlmModels();
  const first = models.find((item) => item.weightsReady);
  if (!first) {
    return;
  }
  try {
    await ensureLocalLlmReady(first.id);
  } catch {
    // 预热失败不阻止 Bridge 启动
  }
}


export const maybeWarmGemma4OnBridgeStart = maybeWarmLocalLlmOnBridgeStart;
