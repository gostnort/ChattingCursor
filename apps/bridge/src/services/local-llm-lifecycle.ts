import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { formatLocalLlmError } from "@chatting-cursor/shared";
import { getLocalLlmServerScriptPath, getRepoRootDir } from "../paths.js";
import { findInstalledLocalLlmModel, inspectModelWeightsReady } from "./local-llm-store.js";
import { resolveScheduledLlmNGpuLayersEnv } from "./scheduler-state.js";


export type LocalLlmWeightsStatus = "ready" | "missing" | "incomplete";


export type LocalLlmLoadState = "down" | "idle" | "loading" | "ready" | "error";


export type LocalLlmHealthDetail = {
  ggufGb?: number;
  nGpuLayers?: number;
  mode?: "gpu" | "mixed" | "cpu" | "unknown";
  loadElapsedSec?: number;
};


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
  detail?: LocalLlmHealthDetail;
};


type SpawnRunner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;


const DEFAULT_PORT = 4322;
const DEFAULT_HOST = "127.0.0.1";
const README_HINT = "Install GGUF weights in Local Models, or run local_llm/server/install.bat (Windows) / install.sh (Linux).";
const INFERENCE_INSTALL_HINT = process.platform === "win32"
  ? "Run local_llm/server/install.bat"
  : "Run local_llm/server/install.sh";


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


type SidecarHealthBody = {
  status?: string;
  detail?: string;
  gguf_gb?: string;
  n_gpu_layers?: string;
  mode?: string;
  load_elapsed_sec?: string;
};


function parseSidecarHealthBody(body: SidecarHealthBody): {
  state: LocalLlmLoadState;
  detail?: string;
  healthDetail?: LocalLlmHealthDetail;
} {
  const ggufGb = body.gguf_gb ? Number(body.gguf_gb) : undefined;
  const nGpuLayers = body.n_gpu_layers ? Number(body.n_gpu_layers) : undefined;
  const loadElapsedSec = body.load_elapsed_sec ? Number(body.load_elapsed_sec) : undefined;
  const mode = body.mode === "gpu" || body.mode === "mixed" || body.mode === "cpu"
    ? body.mode
    : undefined;
  const healthDetail: LocalLlmHealthDetail | undefined = (
    ggufGb !== undefined || nGpuLayers !== undefined || mode || loadElapsedSec !== undefined
  ) ? {
    ggufGb: Number.isFinite(ggufGb) ? ggufGb : undefined,
    nGpuLayers: Number.isFinite(nGpuLayers) ? nGpuLayers : undefined,
    mode,
    loadElapsedSec: Number.isFinite(loadElapsedSec) ? loadElapsedSec : undefined,
  } : undefined;
  if (body.status === "ready") {
    return { state: "ready", healthDetail };
  }
  if (body.status === "idle") {
    return { state: "idle", detail: body.detail?.trim(), healthDetail };
  }
  if (body.status === "error") {
    return {
      state: "error",
      detail: body.detail?.trim() || "本地模型加载失败",
      healthDetail,
    };
  }
  if (body.status === "loading") {
    return { state: "loading", detail: body.detail?.trim(), healthDetail };
  }
  return { state: "down" };
}


/** 探测 sidecar 加载阶段 */
export async function probeLocalLlmLoadState(
  baseUrl = resolveLocalLlmApiBaseUrl(),
): Promise<{ state: LocalLlmLoadState; detail?: string; healthDetail?: LocalLlmHealthDetail }> {
  const root = baseUrl.replace(/\/$/, "");
  try {
    const response = await fetch(`${root}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      return { state: "down", detail: `health HTTP ${response.status}` };
    }
    const body = (await response.json()) as SidecarHealthBody;
    return parseSidecarHealthBody(body);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: "down", detail: message.trim() || "fetch failed" };
  }
}


export async function probeLocalLlmApiHealth(baseUrl = resolveLocalLlmApiBaseUrl()): Promise<boolean> {
  const probe = await probeLocalLlmLoadState(baseUrl);
  return probe.state === "ready";
}


function listLocalLlmPythonCandidates(): string[] {
  const repoRoot = getRepoRootDir();
  return [
    path.join(repoRoot, ".venv", "Scripts", "python.exe"),
    path.join(repoRoot, ".venv", "bin", "python3"),
    path.join(repoRoot, ".venv", "bin", "python"),
  ];
}


function pythonHasInferenceDeps(executable: string): boolean {
  return probeLocalLlmInferenceDeps(executable).ok;
}


/** 探测 llama_cpp / fastapi / uvicorn 是否可导入 */
export function probeLocalLlmInferenceDeps(executable?: string): { ok: true } | { ok: false; detail: string } {
  const target = executable ?? resolveLocalLlmPythonExecutable();
  if (target.includes(path.sep) && !existsSync(target)) {
    return { ok: false, detail: `Python executable not found: ${target}` };
  }
  const runtimePaths = resolveLlamaRuntimePathEntries(target);
  const probeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: prependPathEntries(process.env.PATH, runtimePaths),
  };
  const probe = spawnSync(
    target,
    ["-c", "import llama_cpp, fastapi, uvicorn"],
    { timeout: 30_000, windowsHide: true, encoding: "utf8", env: probeEnv },
  );
  if (probe.status === 0) {
    return { ok: true };
  }
  const stderr = (probe.stderr ?? "").trim();
  const stdout = (probe.stdout ?? "").trim();
  const detail = stderr || stdout || `import probe exited with code ${probe.status ?? "unknown"}`;
  return { ok: false, detail };
}


/** 解析 Python 可执行文件（优先 repo .venv，避免回退到无 llama_cpp 的系统 Python） */
export function resolveLocalLlmPythonExecutable(): string {
  const fromEnv = readEnv("LOCAL_LLM_PYTHON", "GEMMA4_PYTHON");
  if (fromEnv) {
    return fromEnv;
  }
  if (cachedPython) {
    return cachedPython;
  }
  let fallbackExisting: string | null = null;
  for (const candidate of listLocalLlmPythonCandidates()) {
    if (!existsSync(candidate)) {
      continue;
    }
    fallbackExisting = candidate;
    if (pythonHasInferenceDeps(candidate)) {
      cachedPython = candidate;
      return candidate;
    }
  }
  if (fallbackExisting) {
    cachedPython = fallbackExisting;
    return fallbackExisting;
  }
  return process.platform === "win32" ? "python" : "python3";
}


/** 解析 llama-cpp-python 运行时 DLL 目录（CUDA/cuBLAS 等） */
export function resolveLlamaRuntimePathEntries(pythonExecutable?: string): string[] {
  const executable = pythonExecutable ?? resolveLocalLlmPythonExecutable();
  const normalized = path.normalize(executable);
  let venvRoot = "";
  const scriptsMatch = normalized.match(/[\\/]\.venv[\\/]Scripts[\\/]/i);
  if (scriptsMatch) {
    venvRoot = normalized.slice(0, scriptsMatch.index! + ".venv".length + 1);
  } else {
    const binMatch = normalized.match(/[\\/]\.venv[\\/]bin[\\/]/i);
    if (binMatch) {
      venvRoot = normalized.slice(0, binMatch.index! + ".venv".length + 1);
    }
  }
  if (!venvRoot) {
    return [];
  }
  const sitePackages = process.platform === "win32"
    ? path.join(venvRoot, "Lib", "site-packages")
    : path.join(venvRoot, "lib", `python${process.version.match(/^v(\d+\.\d+)/)?.[1] ?? "3.12"}`, "site-packages");
  const candidates = [
    path.join(sitePackages, "nvidia", "cublas", "bin"),
    path.join(sitePackages, "nvidia", "cuda_runtime", "bin"),
    path.join(sitePackages, "bin"),
  ];
  return candidates.filter((entry) => existsSync(entry));
}


function prependPathEntries(basePath: string | undefined, entries: string[]): string {
  if (entries.length === 0) {
    return basePath ?? "";
  }
  const separator = process.platform === "win32" ? ";" : ":";
  const existing = basePath?.trim();
  return existing ? `${entries.join(separator)}${separator}${existing}` : entries.join(separator);
}


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


/** 为 sidecar 子进程合并环境变量 */
export function buildLocalLlmServerEnv(options: {
  modelDir: string;
  modelId: string;
  host: string;
  port: number;
}): NodeJS.ProcessEnv {
  const nCtx = readEnv("LOCAL_LLM_N_CTX", "GEMMA4_N_CTX") || "8192";
  const scheduledLayers = resolveScheduledLlmNGpuLayersEnv();
  const nGpuLayers = scheduledLayers ?? readEnv("LOCAL_LLM_N_GPU_LAYERS", "GEMMA4_N_GPU_LAYERS");
  const maxNew = readEnv("LOCAL_LLM_MAX_NEW_TOKENS", "GEMMA4_MAX_NEW_TOKENS") || "1024";
  const deferLoad = readEnv("LOCAL_LLM_DEFER_MODEL_LOAD", "GEMMA4_DEFER_MODEL_LOAD") || "1";
  const pythonExecutable = resolveLocalLlmPythonExecutable();
  const runtimePaths = resolveLlamaRuntimePathEntries(pythonExecutable);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCAL_LLM_WEIGHTS_DIR: options.modelDir,
    LOCAL_LLM_MODEL_ID: options.modelId,
    LOCAL_LLM_HOST: options.host,
    LOCAL_LLM_PORT: String(options.port),
    LOCAL_LLM_N_CTX: nCtx,
    LOCAL_LLM_MAX_NEW_TOKENS: maxNew,
    LOCAL_LLM_DEFER_MODEL_LOAD: deferLoad,
    GEMMA4_WEIGHTS_DIR: options.modelDir,
    GEMMA4_MODEL_ID: options.modelId,
    GEMMA4_HOST: options.host,
    GEMMA4_PORT: String(options.port),
    GEMMA4_N_CTX: nCtx,
    GEMMA4_MAX_NEW_TOKENS: maxNew,
    GEMMA4_DEFER_MODEL_LOAD: deferLoad,
    PATH: prependPathEntries(process.env.PATH, runtimePaths),
  };
  if (nGpuLayers) {
    env.LOCAL_LLM_N_GPU_LAYERS = nGpuLayers;
    env.GEMMA4_N_GPU_LAYERS = nGpuLayers;
  }
  return env;
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
  const raw = readEnv("LOCAL_LLM_LOAD_TIMEOUT_MS", "GEMMA4_LOAD_TIMEOUT_MS")
    || readEnv("LOCAL_LLM_STARTUP_TIMEOUT_MS", "GEMMA4_STARTUP_TIMEOUT_MS");
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 600_000;
}


function toLocalLlmError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(formatLocalLlmError(message));
}


function formatSpawnExitError(exitCode: number | null): Error {
  const tail = lastSpawnStderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-10)
    .join("\n");
  const hint = `${INFERENCE_INSTALL_HINT}.`;
  const codeText = exitCode === null ? "unknown" : String(exitCode);
  if (tail) {
    return new Error(`Local inference process exited (code ${codeText}).\n${tail}\n${hint}`);
  }
  return new Error(`Local inference process exited (code ${codeText}). ${hint}`);
}


function assertInferenceDepsReady(): void {
  const python = resolveLocalLlmPythonExecutable();
  const probe = probeLocalLlmInferenceDeps(python);
  if (probe.ok) {
    return;
  }
  console.error(`[local-llm] Inference deps check failed (${python}): ${probe.detail}. ${INFERENCE_INSTALL_HINT}`);
  throw new Error(`llama_cpp or inference dependencies missing: ${probe.detail}. ${INFERENCE_INSTALL_HINT}`);
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
  throw toLocalLlmError(
    `本地推理 sidecar 在 ${Math.round(timeoutMs / 1000)} 秒内未响应 /v1/health（端口 4322）。可增大 LOCAL_LLM_SIDECAR_TIMEOUT_MS。`,
  );
}


function formatMixedModeHint(healthDetail?: LocalLlmHealthDetail): string {
  if (healthDetail?.mode !== "mixed") {
    return "";
  }
  const layers = healthDetail.nGpuLayers ?? 35;
  return `混合模式：约 ${layers} 层在 GPU，其余在 CPU 内存。`;
}


function formatLoadingHint(probe: {
  detail?: string;
  healthDetail?: LocalLlmHealthDetail;
}): string {
  const parts: string[] = [];
  if (probe.detail) {
    parts.push(probe.detail);
  }
  const mixed = formatMixedModeHint(probe.healthDetail);
  if (mixed) {
    parts.push(mixed);
  }
  if (probe.healthDetail?.ggufGb) {
    parts.push(`GGUF 约 ${probe.healthDetail.ggufGb.toFixed(1)} GB`);
  }
  if (probe.healthDetail?.loadElapsedSec) {
    parts.push(`已等待 ${probe.healthDetail.loadElapsedSec} 秒`);
  }
  return parts.join("；") || "正在加载 GGUF 到内存/GPU…";
}


/** 启动前估算 GGUF 体积与显存是否匹配 */
export async function preflightLocalLlmModel(modelId: string): Promise<{
  ggufGb: number;
  mixedMode: boolean;
  warning?: string;
}> {
  const model = await findInstalledLocalLlmModel(modelId);
  if (!model) {
    throw new Error(`未找到已安装本地模型：${modelId}`);
  }
  const weights = await inspectLocalLlmWeights(model.dir, model.filenames);
  if (weights !== "ready") {
    throw new Error(`本地模型权重不完整（${model.dir}）。${README_HINT}`);
  }
  const primaryName = model.filenames[0];
  if (!primaryName) {
    const names = await readdir(model.dir);
    const gguf = names.find((name) => name.toLowerCase().endsWith(".gguf"));
    if (!gguf) {
      throw new Error(`未在 ${model.dir} 找到 GGUF 文件`);
    }
    const fileStat = await stat(path.join(model.dir, gguf));
    const ggufGb = fileStat.size / (1024 ** 3);
    return { ggufGb, mixedMode: ggufGb > 11 };
  }
  const fileStat = await stat(path.join(model.dir, primaryName));
  const ggufGb = fileStat.size / (1024 ** 3);
  const nGpuLayersRaw = readEnv("LOCAL_LLM_N_GPU_LAYERS", "GEMMA4_N_GPU_LAYERS");
  const nGpuLayers = nGpuLayersRaw ? Number(nGpuLayersRaw) : -1;
  const mixedMode = nGpuLayers > 0 || (nGpuLayers === -1 && ggufGb > 11);
  let warning: string | undefined;
  if (ggufGb > 20) {
    warning = (
      `GGUF 约 ${ggufGb.toFixed(1)} GB，在 12 GB 显存显卡上建议使用 Q4_K_M（约 15 GB）`
      + " 或 gemma-4-E4B；当前将尝试混合模式（GPU 层 + CPU 内存），首次加载可能需数分钟。"
    );
  } else if (mixedMode) {
    warning = "将使用混合模式：部分 Transformer 层在 GPU，其余在 CPU 内存。";
  }
  return { ggufGb, mixedMode, warning };
}


/** 触发 sidecar 异步加载 GGUF（defer 模式下 health 为 idle 时必需） */
export async function triggerLocalLlmModelLoad(
  baseUrl = resolveLocalLlmApiBaseUrl(),
): Promise<void> {
  const root = baseUrl.replace(/\/$/, "");
  const probe = await probeLocalLlmLoadState(baseUrl);
  if (probe.state === "ready" || probe.state === "loading") {
    return;
  }
  if (probe.state === "down") {
    throw toLocalLlmError("推理 sidecar 未运行（端口 4322），无法加载模型");
  }
  const response = await fetch(`${root}/load`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok && response.status !== 503) {
    const body = await response.text();
    throw new Error(`触发模型加载失败 (${response.status}): ${body.slice(0, 300)}`);
  }
}


async function waitForModelReady(timeoutMs: number): Promise<void> {
  const baseUrl = resolveLocalLlmApiBaseUrl();
  const deadline = Date.now() + timeoutMs;
  let lastLoadingHint = "";
  while (Date.now() < deadline) {
    const probe = await probeLocalLlmLoadState(baseUrl);
    if (probe.state === "ready") {
      return;
    }
    if (probe.state === "error") {
      throw toLocalLlmError(probe.detail ?? "本地模型加载失败");
    }
    if (probe.state === "idle") {
      await triggerLocalLlmModelLoad(baseUrl);
    }
    lastLoadingHint = formatLoadingHint(probe);
    if (managedChild && managedChild.exitCode !== null) {
      throw formatSpawnExitError(managedChild.exitCode);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const suffix = lastLoadingHint ? ` ${lastLoadingHint}` : "";
  throw toLocalLlmError(
    `本地模型在 ${Math.round(timeoutMs / 1000)} 秒内未加载完成（加载超时）。`
    + "若 GGUF 过大或显存不足，请改用 Q4_K_M 量化或设置 LOCAL_LLM_N_GPU_LAYERS=35。"
    + ` 可增大 LOCAL_LLM_LOAD_TIMEOUT_MS。${suffix}`,
  );
}


async function spawnManagedServer(modelId: string): Promise<void> {
  assertInferenceDepsReady();
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
  const sidecarProbe = await probeLocalLlmLoadState();
  if (sidecarProbe.state === "down") {
    killProcessListeningOnPort(port);
    const waitMs = process.platform === "win32" ? 500 : 200;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
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
  const { assertOfflineSchedulerAllows, planOfflineLlmLoad } = await import("./resource-scheduler.js");
  assertOfflineSchedulerAllows("启动离线推理服务");
  const preflight = await preflightLocalLlmModel(modelId);
  planOfflineLlmLoad(modelId, preflight.ggufGb);
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


/** 确保模型已加载完成 */
export async function ensureLocalLlmReady(modelId: string): Promise<void> {
  const baseUrl = resolveLocalLlmApiBaseUrl();
  if (activeModelId === modelId && await probeLocalLlmApiHealth(baseUrl)) {
    return;
  }
  await ensureLocalLlmSidecarStarted(modelId);
  const preflight = await preflightLocalLlmModel(modelId);
  if (preflight.warning) {
    console.warn(`[local-llm] ${preflight.warning}`);
  }
  const probe = await probeLocalLlmLoadState(baseUrl);
  if (probe.state === "idle") {
    await triggerLocalLlmModelLoad(baseUrl);
  }
  await waitForModelReady(resolveModelLoadTimeoutMs());
}


/** Bridge 退出时停止托管子进程 */
/** 重置 spawn 状态，避免调度停摆 */
export function resetLocalLlmSpawnState(): void {
  spawnPromise = null;
}


export async function stopManagedLocalLlm(): Promise<void> {
  const child = managedChild;
  managedChild = null;
  activeModelId = null;
  resetLocalLlmSpawnState();
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
export function killProcessListeningOnPort(port: number): boolean {
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


/** 当前 sidecar 正在服务的 model id（无则为 null） */
export function getActiveLocalLlmModelId(): string | null {
  return activeModelId;
}


/** 删除模型前：停止托管 sidecar 并清理端口占用，Windows 额外等待文件锁释放 */
export async function forceStopLocalLlmSidecar(): Promise<{ unloaded: boolean }> {
  const hadManaged = managedChild !== null && managedChild.exitCode === null;
  resetLocalLlmSpawnState();
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
  const loadError = probe.state === "error"
    ? formatLocalLlmError(probe.detail ?? "本地模型加载失败")
    : undefined;
  let message: string | undefined;
  const mixedHint = formatMixedModeHint(probe.healthDetail);
  if (loadError) {
    message = loadError;
  } else if (running) {
    message = mixedHint || undefined;
  } else if (weights !== "ready") {
    message = README_HINT;
  } else if (probe.state === "idle") {
    const sizeHint = probe.healthDetail?.ggufGb
      ? `（GGUF 约 ${probe.healthDetail.ggufGb.toFixed(1)} GB）`
      : "";
    message = `推理 sidecar 已就绪；发送首条消息时将加载模型权重${sizeHint}。${mixedHint}`;
  } else if (probe.state === "loading" || spawnPromise !== null) {
    message = formatLoadingHint(probe);
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
    detail: probe.healthDetail,
  };
}


/** Bridge 启动时可选预热 */
export async function maybeWarmLocalLlmOnBridgeStart(): Promise<void> {
  const flag = readEnv("LOCAL_LLM_AUTO_START_ON_BRIDGE", "GEMMA4_AUTO_START_ON_BRIDGE");
  if (flag !== "1" && flag?.toLowerCase() !== "true") {
    return;
  }
  const deps = probeLocalLlmInferenceDeps();
  if (!deps.ok) {
    console.warn(`[local-llm] Warmup skipped: ${deps.detail}. ${INFERENCE_INSTALL_HINT}`);
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

