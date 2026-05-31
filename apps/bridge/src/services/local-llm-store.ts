import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sortAlphaDescNumeric } from "@chatting-cursor/shared";
import {
  getLocalLlmHfDownloadCacheDir,
  getLocalLlmHfDownloadStagingDir,
  getLocalLlmRootDir,
  getRepoRootDir,
} from "../paths.js";
import { groupGgufFilenames } from "./local-llm-gguf-group.js";
import {
  computeDownloadPercent,
  formatInstallProgressLabel,
  measureDirectoryBytes,
  resolveHfFilenamesTotalBytes,
} from "./local-llm-hf-size.js";
import {
  cacheInstallJob,
  getInstallJobStatus,
  markInstallJobActive,
  recoverStaleInstallJobs,
  saveInstallJob,
  unmarkInstallJobActive,
  type InstallJobPhase,
  type InstallJobStatus,
} from "./local-llm-install-jobs.js";


export type { InstallJobStatus };


export type LocalLlmModelManifest = {
  id: string;
  author: string;
  modelSlug: string;
  repoId: string;
  displayName: string;
  ggufGroupKey: string;
  filenames: string[];
  defaultPrompt: string;
  installedAt: string;
};


export type LocalLlmRegistry = {
  savedAuthors: string[];
};


export type LocalLlmInstalledModel = LocalLlmModelManifest & {
  dir: string;
  weightsReady: boolean;
};


export type HfModelSummary = {
  repoId: string;
  displayName: string;
};


const MODEL_JSON = "model.json";
const REGISTRY_JSON = "registry.json";
const LEGACY_GGUF = "gemma-4-E4B-it-UD-Q8_K_XL.gguf";
const LEGACY_REPO = "unsloth/gemma-4-E4B-it-GGUF";
const LEGACY_AUTHOR = "unsloth";
const LEGACY_SLUG = "gemma-4-E4B-it-GGUF";
const NON_AUTHOR_DIR_NAMES = new Set(["server", ".install-jobs", ".hf-download-cache"]);


/** 判断目录名是否可作为 HF 作者（排除 server、点目录、缓存/任务目录） */
function isValidLocalLlmAuthorName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith(".")) {
    return false;
  }
  if (NON_AUTHOR_DIR_NAMES.has(trimmed)) {
    return false;
  }
  return true;
}


/** 作者目录下是否至少有一个含 model.json 的有效安装 */
async function authorDirHasInstalledModel(authorPath: string): Promise<boolean> {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(authorPath, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifest = await readJsonFile<LocalLlmModelManifest>(path.join(authorPath, entry.name, MODEL_JSON));
    if (manifest) {
      return true;
    }
  }
  return false;
}


/** 扫描 local_llm 下含有效 model.json 的作者目录 */
async function listAuthorDirsWithInstalledModels(root: string): Promise<string[]> {
  const found: string[] = [];
  let entries: Dirent[] = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidLocalLlmAuthorName(entry.name)) {
      continue;
    }
    if (await authorDirHasInstalledModel(path.join(root, entry.name))) {
      found.push(entry.name);
    }
  }
  return found;
}


/** 构建本地模型 id：local-llm/{author}/{slug} */
export function buildLocalLlmModelId(author: string, modelSlug: string): string {
  return `local-llm/${author.trim()}/${modelSlug.trim()}`;
}


/** 从 repo_id 推导 model_slug */
export function modelSlugFromRepoId(repoId: string): string {
  const slash = repoId.lastIndexOf("/");
  return slash >= 0 ? repoId.slice(slash + 1) : repoId;
}


/** 规范化为 local-llm/{author}/{slug}（兼容路由仅传 author/slug 的旧客户端） */
export function normalizeLocalLlmModelId(rawId: string): string {
  const trimmed = rawId.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("local-llm/")) {
    return trimmed;
  }
  if (trimmed.includes("/")) {
    return `local-llm/${trimmed}`;
  }
  return trimmed;
}


/** 解析路由中的 model id（支持分段路径与整段 encodeURIComponent） */
export function parseLocalLlmRouteModelId(rawParam: string): string {
  const trimmed = rawParam.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return "";
  }
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    decoded = trimmed;
  }
  return normalizeLocalLlmModelId(decoded);
}


/** 将 model id 转为 URL 路径（保留 author/model 之间的斜杠，仅编码各段） */
export function localLlmModelIdToRoutePath(modelId: string): string {
  return modelId
    .split("/")
    .map((segment) => encodeURIComponent(segment.trim()))
    .filter(Boolean)
    .join("/");
}


function isAllowedModelDirEntry(name: string): boolean {
  if (name === MODEL_JSON) {
    return true;
  }
  if (name.toLowerCase().endsWith(".gguf")) {
    return true;
  }
  return false;
}


/** 安装后清理 model 目录：移除 .cache、.lock 及非 gguf/model.json 的残留 */
export async function cleanupModelDirAfterDownload(dir: string): Promise<void> {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isAllowedModelDirEntry(entry.name)) {
        continue;
      }
      await rm(entryPath, { recursive: true, force: true });
      continue;
    }
    if (isAllowedModelDirEntry(entry.name)) {
      continue;
    }
    if (entry.name.endsWith(".lock")) {
      await rm(entryPath, { force: true });
      continue;
    }
    await rm(entryPath, { force: true });
  }
}


/** 递归收集目录内全部 GGUF 文件路径 */
async function collectGgufFilePaths(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectGgufFilePaths(entryPath));
      continue;
    }
    if (entry.name.toLowerCase().endsWith(".gguf")) {
      results.push(entryPath);
    }
  }
  return results;
}


/** 将暂存目录中的 GGUF 移到 model 目录（仅保留 basename） */
async function moveGgufFilesToModelDir(
  stagingDir: string,
  targetDir: string,
  filenames: string[],
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const expectedBasenames = filenames.map((name) => path.basename(name.replace(/\\/g, "/")));
  const found = await collectGgufFilePaths(stagingDir);
  const byBasename = new Map<string, string>();
  for (const filePath of found) {
    byBasename.set(path.basename(filePath), filePath);
  }
  for (const base of expectedBasenames) {
    const source = byBasename.get(base);
    if (!source) {
      continue;
    }
    const dest = path.join(targetDir, base);
    try {
      await rename(source, dest);
    } catch {
      await copyFile(source, dest);
      await rm(source, { force: true });
    }
  }
}


/** 扫描 local_llm 下全部 model 目录，清除嵌套 .cache 等遗留物 */
export async function purgeNestedModelCachesUnderLocalLlm(): Promise<void> {
  const root = getLocalLlmRootDir();
  let authorNames: string[] = [];
  try {
    authorNames = await readdir(root);
  } catch {
    return;
  }
  for (const author of authorNames) {
    if (!isValidLocalLlmAuthorName(author)) {
      continue;
    }
    const authorPath = path.join(root, author);
    let slugEntries: Dirent[] = [];
    try {
      slugEntries = await readdir(authorPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const slugEntry of slugEntries) {
      if (!slugEntry.isDirectory()) {
        continue;
      }
      await cleanupModelDirAfterDownload(path.join(authorPath, slugEntry.name));
    }
  }
}


/** Bridge 启动时：迁移安装任务、清除 model 目录内嵌套 .cache */
export async function runLocalLlmStartupMaintenance(): Promise<void> {
  await recoverStaleInstallJobs();
  await purgeNestedModelCachesUnderLocalLlm();
}


/** HF API 路径：仅编码各段，保留 author/model 之间的斜杠 */
export function encodeHfRepoId(repoId: string): string {
  return repoId
    .split("/")
    .map((segment) => encodeURIComponent(segment.trim()))
    .filter(Boolean)
    .join("/");
}


/** 解析 HF 访问令牌 */
export function resolveHfToken(): string {
  return process.env.HF_TOKEN?.trim() || process.env.HUGGINGFACE_HUB_TOKEN?.trim() || "";
}


function registryPath(): string {
  return path.join(getLocalLlmRootDir(), REGISTRY_JSON);
}


function modelDir(author: string, modelSlug: string): string {
  return path.join(getLocalLlmRootDir(), author, modelSlug);
}


function manifestPath(author: string, modelSlug: string): string {
  return path.join(modelDir(author, modelSlug), MODEL_JSON);
}


function stripUtf8Bom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}


async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = stripUtf8Bom(await readFile(filePath, "utf8"));
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}


async function writeRegistry(registry: LocalLlmRegistry): Promise<void> {
  const root = getLocalLlmRootDir();
  await mkdir(root, { recursive: true });
  registry.savedAuthors = sortAlphaDescNumeric(
    [...new Set(registry.savedAuthors.map((item) => item.trim()).filter(isValidLocalLlmAuthorName))],
    (item) => item,
  );
  await writeFile(registryPath(), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}


/** 读取 registry.json（不存在则返回空） */
export async function readLocalLlmRegistry(): Promise<LocalLlmRegistry> {
  const existing = await readJsonFile<LocalLlmRegistry>(registryPath());
  if (existing?.savedAuthors) {
    return { savedAuthors: [...existing.savedAuthors] };
  }
  return { savedAuthors: [] };
}


/** 列出作者：registry 中保存的作者 + 含 model.json 的有效安装目录 */
export async function listLocalLlmAuthors(): Promise<string[]> {
  const registry = await readLocalLlmRegistry();
  const root = getLocalLlmRootDir();
  await mkdir(root, { recursive: true });
  const fromRegistry = registry.savedAuthors.filter(isValidLocalLlmAuthorName);
  const fromDisk = await listAuthorDirsWithInstalledModels(root);
  return sortAlphaDescNumeric(
    [...new Set([...fromRegistry, ...fromDisk])],
    (item) => item,
  );
}


/** 添加作者占位（写入 registry） */
export async function addLocalLlmAuthor(author: string): Promise<string[]> {
  const trimmed = author.trim();
  if (!trimmed || !/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error("作者名仅允许字母、数字、下划线、点、连字符");
  }
  const registry = await readLocalLlmRegistry();
  if (!registry.savedAuthors.includes(trimmed)) {
    registry.savedAuthors.push(trimmed);
  }
  await writeRegistry(registry);
  await mkdir(path.join(getLocalLlmRootDir(), trimmed), { recursive: true });
  return listLocalLlmAuthors();
}


/** 扫描 local_llm 下全部有效作者目录名（不要求已有 model.json） */
async function listValidAuthorDirNames(root: string): Promise<string[]> {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isValidLocalLlmAuthorName(entry.name))
    .map((entry) => entry.name);
}


/** 扫描已安装模型（author/model_slug/model.json） */
export async function listInstalledLocalLlmModels(): Promise<LocalLlmInstalledModel[]> {
  await maybeMigrateLegacyGemma4Weights();
  const root = getLocalLlmRootDir();
  await mkdir(root, { recursive: true });
  const authors = sortAlphaDescNumeric(
    [...new Set([
      ...(await listLocalLlmAuthors()),
      ...(await listValidAuthorDirNames(root)),
    ])],
    (item) => item,
  );
  const models: LocalLlmInstalledModel[] = [];
  for (const author of authors) {
    const authorPath = path.join(root, author);
    let slugs: string[] = [];
    try {
      const entries = await readdir(authorPath, { withFileTypes: true });
      slugs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const manifestFile = manifestPath(author, slug);
      const manifest = await readJsonFile<LocalLlmModelManifest>(manifestFile);
      if (!manifest) {
        continue;
      }
      const dir = modelDir(author, slug);
      models.push({
        ...manifest,
        dir,
        weightsReady: await inspectModelWeightsReady(dir, manifest.filenames),
      });
    }
  }
  return sortAlphaDescNumeric(models, (item) => `${item.author}/${item.modelSlug}`);
}


/** 按 id 查找已安装模型 */
export async function findInstalledLocalLlmModel(modelId: string): Promise<LocalLlmInstalledModel | null> {
  const normalizedId = normalizeLocalLlmModelId(modelId);
  const models = await listInstalledLocalLlmModels();
  return models.find((item) => item.id === normalizedId) ?? null;
}


/** 检测模型目录内 GGUF 是否齐全 */
export async function inspectModelWeightsReady(dir: string, filenames: string[]): Promise<boolean> {
  if (filenames.length === 0) {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return false;
    }
    return names.some((name) => name.toLowerCase().endsWith(".gguf"));
  }
  for (const filename of filenames) {
    const base = path.basename(filename.replace(/\\/g, "/"));
    const target = path.join(dir, base);
    if (!existsSync(target)) {
      return false;
    }
  }
  return true;
}


/** Hugging Face Hub：列出作者的 GGUF 相关仓库（排除已安装） */
export async function listHfModelsByAuthor(author: string): Promise<HfModelSummary[]> {
  const trimmedAuthor = author.trim();
  const token = resolveHfToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const params = new URLSearchParams({
    author: trimmedAuthor,
    limit: "100",
    sort: "downloads",
    direction: "-1",
  });
  const response = await fetch(`https://huggingface.co/api/models?${params.toString()}`, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HF 模型列表失败 (${response.status}): ${body.slice(0, 300)}`);
  }
  const payload = await response.json() as Array<{ id?: string; modelId?: string; tags?: string[] }>;
  const rows = Array.isArray(payload) ? payload : [];
  const installed = await listInstalledLocalLlmModels();
  const installedRepoIds = new Set(
    installed
      .filter((item) => item.author === trimmedAuthor)
      .map((item) => item.repoId),
  );
  const filtered = rows
    .map((item) => {
      const repoId = (item.id ?? item.modelId ?? "").trim();
      if (!repoId) {
        return null;
      }
      if (installedRepoIds.has(repoId)) {
        return null;
      }
      const tags = (item.tags ?? []).map((tag) => tag.toLowerCase());
      const looksGguf = repoId.toLowerCase().includes("gguf")
        || tags.includes("gguf")
        || tags.some((tag) => tag.includes("gguf"));
      if (!looksGguf) {
        return null;
      }
      return { repoId, displayName: repoId.split("/").pop() ?? repoId };
    })
    .filter((item): item is HfModelSummary => item !== null);
  return sortAlphaDescNumeric(filtered, (item) => item.displayName);
}


type HfTreeEntry = { path?: string; type?: string };


/** Hugging Face Hub：列出仓库指定 revision 的文件树 */
async function listHfRepoTree(repoId: string, revision: string): Promise<HfTreeEntry[]> {
  const token = resolveHfToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const encoded = encodeHfRepoId(repoId);
  const response = await fetch(
    `https://huggingface.co/api/models/${encoded}/tree/${encodeURIComponent(revision)}?recursive=true`,
    { headers, signal: AbortSignal.timeout(120_000) },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HF 文件列表失败 (${response.status}, ${revision}): ${body.slice(0, 300)}`);
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload as HfTreeEntry[] : [];
}


/** Hugging Face Hub：列出仓库内全部 .gguf 路径（依次尝试 main / master） */
export async function listHfGgufFilenames(repoId: string): Promise<string[]> {
  const revisions = ["main", "master"];
  let lastError = "";
  for (const revision of revisions) {
    try {
      const payload = await listHfRepoTree(repoId, revision);
      const files = payload
        .filter((entry) => entry.type === "file" && typeof entry.path === "string")
        .map((entry) => entry.path as string)
        .filter((name) => name.toLowerCase().endsWith(".gguf"));
      if (files.length > 0) {
        return files.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
      }
      lastError = `revision ${revision} 下未找到 .gguf 文件`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError || "仓库内未找到 .gguf 文件");
}


/** Hugging Face Hub：列出仓库内 .gguf 并按分片分组 */
export async function listHfGgufGroups(repoId: string): Promise<ReturnType<typeof groupGgufFilenames>> {
  const groups = groupGgufFilenames(await listHfGgufFilenames(repoId));
  return sortAlphaDescNumeric(groups, (item) => item.displayLabel);
}


/** 解析安装时要下载的 GGUF 文件列表（必须指定分组内 filenames） */
export async function resolveInstallGgufFilenames(
  _repoId: string,
  filenames: string[],
): Promise<string[]> {
  const resolved = filenames.map((name) => name.replace(/\\/g, "/").trim()).filter(Boolean);
  if (resolved.length === 0) {
    throw new Error("请先在界面选择要下载的 GGUF 量化/分片组");
  }
  return resolved;
}


function resolveHfExecutable(): string {
  return process.platform === "win32" ? "hf.exe" : "hf";
}


/** hf CLI 子进程环境：Windows 默认 GBK 控制台无法输出 ✓ 等 Unicode，会导致 exit 1 */
export function buildLocalLlmHfSpawnEnv(token: string, cacheDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (token) {
    env.HF_TOKEN = token;
    env.HUGGINGFACE_HUB_TOKEN = token;
  }
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  if (process.platform === "win32") {
    env.PYTHONLEGACYWINDOWSSTDIO = "0";
  }
  const hubCache = path.join(cacheDir, "hub");
  // hf CLI 禁止同时使用 --local-dir 与 --cache-dir；统一临时缓存改由 HF_HOME 指向
  env.HF_HOME = cacheDir;
  env.HF_HUB_CACHE = hubCache;
  env.HUGGINGFACE_HUB_CACHE = hubCache;
  env.TRANSFORMERS_CACHE = path.join(cacheDir, "transformers");
  env.XET_CACHE = path.join(cacheDir, "xet");
  delete env.HF_HUB_DISABLE_SYMLINKS_WARNING;
  return env;
}


/** 检查 targetDir 内是否已有所需 GGUF 分片（basename 匹配） */
export async function verifyGgufFilenamesInDir(dir: string, filenames: string[]): Promise<boolean> {
  const basenames = filenames.map((name) => path.basename(name.replace(/\\/g, "/")));
  return inspectModelWeightsReady(dir, basenames);
}


/** 清空 HF 统一下载缓存（安装任务开始/结束时调用，避免残留 .cache 分片） */
export async function clearLocalLlmHfDownloadCache(): Promise<void> {
  await rm(getLocalLlmHfDownloadCacheDir(), { recursive: true, force: true });
}


export { getLocalLlmHfDownloadCacheDir } from "../paths.js";


const INSTALL_PROGRESS_POLL_MS = 5_000;


/** 合并更新安装任务进度字段 */
async function patchInstallJob(jobId: string, patch: Partial<InstallJobStatus>): Promise<void> {
  const current = await getInstallJobStatus(jobId);
  const base: InstallJobStatus = current ?? { jobId, state: "running", progress: "" };
  await saveInstallJob({ ...base, ...patch, jobId });
}


/** 根据磁盘占用与总量刷新安装进度 */
async function refreshInstallDownloadProgress(
  jobId: string,
  targetDir: string,
  totalBytes: number | null,
  phase: InstallJobPhase,
  detailMessage?: string,
): Promise<void> {
  const downloadedBytes = await measureDirectoryBytes(targetDir);
  const percent = computeDownloadPercent(downloadedBytes, totalBytes);
  const progress = detailMessage
    ?? formatInstallProgressLabel(downloadedBytes, totalBytes, percent);
  await patchInstallJob(jobId, {
    state: "running",
    phase,
    totalBytes,
    downloadedBytes,
    percent,
    progress,
  });
}


/** 使用 hf CLI 下载分组内全部分片，并每 5 秒刷新磁盘已下载字节 */
async function downloadGgufGroup(
  repoId: string,
  filenames: string[],
  targetDir: string,
  jobId: string,
  totalBytes: number | null,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const cacheDir = getLocalLlmHfDownloadCacheDir();
  const stagingDir = getLocalLlmHfDownloadStagingDir(jobId);
  await mkdir(stagingDir, { recursive: true });
  const hf = resolveHfExecutable();
  const token = resolveHfToken();
  const env = buildLocalLlmHfSpawnEnv(token, cacheDir);
  await patchInstallJob(jobId, {
    state: "running",
    phase: "downloading",
    totalBytes,
    progress: `正在下载 ${filenames.length} 个 GGUF 分片…`,
  });
  await refreshInstallDownloadProgress(jobId, stagingDir, totalBytes, "downloading");
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const stopPolling = (): void => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };
  pollTimer = setInterval(() => {
    void refreshInstallDownloadProgress(jobId, stagingDir, totalBytes, "downloading").catch(() => undefined);
  }, INSTALL_PROGRESS_POLL_MS);
  try {
    await new Promise<void>((resolve, reject) => {
      const args = [
        "download",
        repoId,
        ...filenames,
        "--local-dir",
        stagingDir,
      ];
      const child = spawn(hf, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      activeInstallDownloads.set(jobId, child);
      let stderr = "";
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout = `${stdout}${text}`.slice(-8000);
        const line = text.trim().split(/\r?\n/).pop()?.trim();
        if (line) {
          void refreshInstallDownloadProgress(jobId, stagingDir, totalBytes, "downloading", line).catch(() => undefined);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr = `${stderr}${text}`.slice(-8000);
        const line = text.trim().split(/\r?\n/).pop()?.trim();
        if (line) {
          void refreshInstallDownloadProgress(jobId, stagingDir, totalBytes, "downloading", line).catch(() => undefined);
        }
      });
      child.on("error", (error) => {
        reject(new Error(`无法启动 hf CLI：${error.message}。请 pip install huggingface-hub 并确保 hf 在 PATH 中。`));
      });
      child.on("exit", (code) => {
        activeInstallDownloads.delete(jobId);
        void (async () => {
          if (code === 0) {
            resolve();
            return;
          }
          if (await verifyGgufFilenamesInDir(stagingDir, filenames)) {
            resolve();
            return;
          }
          const detail = (stderr || stdout).trim().slice(-1000);
          reject(new Error(`hf download 失败 (exit ${code ?? "?"}): ${detail || "无输出"}`));
        })().catch(reject);
      });
    });
    await refreshInstallDownloadProgress(jobId, stagingDir, totalBytes, "downloading");
    if (!(await verifyGgufFilenamesInDir(stagingDir, filenames))) {
      throw new Error("下载完成但未在暂存目录找到所需 GGUF 文件");
    }
    await moveGgufFilesToModelDir(stagingDir, targetDir, filenames);
    await cleanupModelDirAfterDownload(targetDir);
  } finally {
    stopPolling();
    await rm(stagingDir, { recursive: true, force: true });
  }
}


export { getInstallJobStatus } from "./local-llm-install-jobs.js";


const activeInstallDownloads = new Map<string, ChildProcess>();
const activeInstallTargets = new Map<string, { author: string; modelSlug: string }>();


/** 删除模型时取消同目录进行中的安装任务 */
export async function cancelActiveInstallsForModel(author: string, modelSlug: string): Promise<boolean> {
  let cancelled = false;
  for (const [jobId, target] of activeInstallTargets) {
    if (target.author !== author || target.modelSlug !== modelSlug) {
      continue;
    }
    const child = activeInstallDownloads.get(jobId);
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      cancelled = true;
    }
    activeInstallDownloads.delete(jobId);
    activeInstallTargets.delete(jobId);
    const current = await getInstallJobStatus(jobId);
    if (current?.state === "running") {
      await saveInstallJob({
        ...current,
        state: "error",
        phase: "error",
        progress: "已取消",
        error: "用户删除模型，安装已取消",
      });
      unmarkInstallJobActive(jobId);
      cancelled = true;
    }
  }
  return cancelled;
}


/** 异步安装模型（返回 jobId，前端轮询进度） */
export function startLocalLlmInstall(options: {
  author: string;
  repoId: string;
  ggufGroupKey?: string;
  filenames?: string[];
  displayName?: string;
  defaultPrompt?: string;
}): string {
  const jobId = `install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const status: InstallJobStatus = { jobId, state: "running", progress: "排队中…" };
  markInstallJobActive(jobId);
  cacheInstallJob(status);
  void saveInstallJob(status);
  void runInstallJob(jobId, options).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const current = await getInstallJobStatus(jobId);
    await saveInstallJob({
      ...(current ?? { jobId, progress: "失败" }),
      jobId,
      state: "error",
      phase: "error",
      progress: current?.progress?.trim() ? current.progress : "失败",
      error: message,
    });
  }).finally(() => {
    unmarkInstallJobActive(jobId);
  });
  return jobId;
}


/** 安装收尾：写入 model.json、更新 registry、标记 job done（测试与恢复路径复用） */
export async function finalizeLocalLlmInstall(
  jobId: string,
  options: {
    author: string;
    repoId: string;
    ggufGroupKey: string;
    filenames: string[];
    displayName?: string;
    defaultPrompt?: string;
  },
  targetDir: string,
  totalBytes: number | null,
): Promise<LocalLlmInstalledModel> {
  const author = options.author;
  const repoId = options.repoId;
  const modelSlug = modelSlugFromRepoId(repoId);
  await patchInstallJob(jobId, { state: "running", phase: "finalizing", progress: "正在清理下载缓存…" });
  await cleanupModelDirAfterDownload(targetDir);
  await patchInstallJob(jobId, { state: "running", phase: "finalizing", progress: "正在写入 model.json…" });
  const manifest: LocalLlmModelManifest = {
    id: buildLocalLlmModelId(author, modelSlug),
    author,
    modelSlug,
    repoId,
    displayName: options.displayName?.trim() || modelSlug,
    ggufGroupKey: options.ggufGroupKey,
    filenames: options.filenames.map((name) => path.basename(name.replace(/\\/g, "/"))),
    defaultPrompt: options.defaultPrompt?.trim()
      || "You are a helpful assistant running locally for ChattingCursor. Answer clearly and helpfully.",
    installedAt: new Date().toISOString(),
  };
  await mkdir(targetDir, { recursive: true });
  await writeFile(manifestPath(author, modelSlug), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const registry = await readLocalLlmRegistry();
  if (!registry.savedAuthors.includes(author)) {
    registry.savedAuthors.push(author);
    await writeRegistry(registry);
  }
  const installed = await findInstalledLocalLlmModel(manifest.id);
  if (!installed) {
    throw new Error("安装完成但无法读取 model.json");
  }
  const finalBytes = await measureDirectoryBytes(targetDir);
  const percent = computeDownloadPercent(finalBytes, totalBytes) ?? (totalBytes ? 100 : null);
  await saveInstallJob({
    jobId,
    state: "done",
    phase: "done",
    progress: totalBytes
      ? formatInstallProgressLabel(finalBytes, totalBytes, percent ?? 100)
      : "完成",
    totalBytes,
    downloadedBytes: finalBytes,
    percent: percent ?? 100,
    model: installed as unknown as Record<string, unknown>,
  });
  return installed;
}


async function runInstallJob(
  jobId: string,
  options: {
    author: string;
    repoId: string;
    ggufGroupKey?: string;
    filenames?: string[];
    displayName?: string;
    defaultPrompt?: string;
  },
): Promise<void> {
  await clearLocalLlmHfDownloadCache();
  const author = options.author.trim();
  const repoId = options.repoId.trim();
  const modelSlug = modelSlugFromRepoId(repoId);
  activeInstallTargets.set(jobId, { author, modelSlug });
  try {
    const targetDir = modelDir(author, modelSlug);
    await patchInstallJob(jobId, {
      state: "running",
      phase: "queued",
      progress: `准备安装到 ${targetDir}`,
    });
    const filenames = await resolveInstallGgufFilenames(repoId, options.filenames ?? []);
    const groups = groupGgufFilenames(filenames);
    const ggufGroupKey = options.ggufGroupKey?.trim()
      || (groups.length === 1 ? groups[0]!.groupKey : modelSlug);
    await patchInstallJob(jobId, { state: "running", phase: "resolving", progress: "正在查询文件总大小…" });
    const totalBytes = await resolveHfFilenamesTotalBytes(repoId, filenames);
    const weightsAlreadyPresent = await verifyGgufFilenamesInDir(targetDir, filenames);
    if (weightsAlreadyPresent) {
      await patchInstallJob(jobId, {
        state: "running",
        phase: "finalizing",
        progress: "权重已存在，正在写入 model.json…",
      });
    } else {
      await downloadGgufGroup(repoId, filenames, targetDir, jobId, totalBytes);
    }
    await finalizeLocalLlmInstall(
      jobId,
      {
        author,
        repoId,
        ggufGroupKey,
        filenames,
        displayName: options.displayName,
        defaultPrompt: options.defaultPrompt,
      },
      targetDir,
      totalBytes,
    );
  } finally {
    activeInstallTargets.delete(jobId);
    activeInstallDownloads.delete(jobId);
    await clearLocalLlmHfDownloadCache();
  }
}


async function removePathRecursive(target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (!existsSync(target)) {
        return;
      }
    } catch (error: unknown) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown");
  throw new Error(`无法删除目录 ${target}：${detail}`);
}


/** 作者无已安装模型时从 registry 移除占位 */
async function removeAuthorFromRegistryIfEmpty(author: string): Promise<void> {
  const registry = await readLocalLlmRegistry();
  if (!registry.savedAuthors.includes(author)) {
    return;
  }
  registry.savedAuthors = registry.savedAuthors.filter((item) => item !== author);
  await writeRegistry(registry);
}


/** 删除已安装模型目录；作者目录无有效安装时一并移除 */
export async function deleteInstalledLocalLlmModel(modelId: string): Promise<void> {
  const normalizedId = normalizeLocalLlmModelId(modelId);
  const model = await findInstalledLocalLlmModel(normalizedId);
  if (!model) {
    throw new Error(`未找到已安装模型：${normalizedId}`);
  }
  const authorDir = path.join(getLocalLlmRootDir(), model.author);
  await removePathRecursive(model.dir);
  if (existsSync(model.dir)) {
    throw new Error(`删除后模型目录仍存在：${model.dir}`);
  }
  const hasRemainingModel = await authorDirHasInstalledModel(authorDir);
  if (!hasRemainingModel) {
    if (existsSync(authorDir)) {
      await removePathRecursive(authorDir);
    }
    await removeAuthorFromRegistryIfEmpty(model.author);
  }
}


/** 更新 defaultPrompt */
export async function updateLocalLlmDefaultPrompt(modelId: string, defaultPrompt: string): Promise<LocalLlmInstalledModel> {
  const model = await findInstalledLocalLlmModel(modelId);
  if (!model) {
    throw new Error(`未找到已安装模型：${modelId}`);
  }
  const manifestFile = manifestPath(model.author, model.modelSlug);
  const manifest = await readJsonFile<LocalLlmModelManifest>(manifestFile);
  if (!manifest) {
    throw new Error("model.json 不存在");
  }
  manifest.defaultPrompt = defaultPrompt.trim();
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const updated = await findInstalledLocalLlmModel(modelId);
  if (!updated) {
    throw new Error("更新后无法读取模型");
  }
  return updated;
}


/** 将 Gemma4/llm_source 中已有 GGUF 迁移到 local_llm/unsloth/gemma-4-E4B-it-GGUF/ */
export async function maybeMigrateLegacyGemma4Weights(): Promise<boolean> {
  const legacyDir = path.join(getRepoRootDir(), "Gemma4", "llm_source");
  if (!existsSync(legacyDir)) {
    return false;
  }
  let names: string[] = [];
  try {
    names = await readdir(legacyDir);
  } catch {
    return false;
  }
  const ggufFiles = names.filter((name) => name.toLowerCase().endsWith(".gguf"));
  if (ggufFiles.length === 0) {
    return false;
  }
  const targetDir = modelDir(LEGACY_AUTHOR, LEGACY_SLUG);
  const manifestFile = manifestPath(LEGACY_AUTHOR, LEGACY_SLUG);
  if (existsSync(manifestFile)) {
    return false;
  }
  await mkdir(targetDir, { recursive: true });
  const moved: string[] = [];
  for (const name of ggufFiles) {
    const source = path.join(legacyDir, name);
    const dest = path.join(targetDir, name);
    if (existsSync(dest)) {
      continue;
    }
    await rename(source, dest);
    moved.push(name);
  }
  if (moved.length === 0) {
    return false;
  }
  const manifest: LocalLlmModelManifest = {
    id: buildLocalLlmModelId(LEGACY_AUTHOR, LEGACY_SLUG),
    author: LEGACY_AUTHOR,
    modelSlug: LEGACY_SLUG,
    repoId: LEGACY_REPO,
    displayName: LEGACY_SLUG,
    ggufGroupKey: LEGACY_GGUF.replace(/\.gguf$/i, ""),
    filenames: moved,
    defaultPrompt: "You are Gemma 4 running locally for ChattingCursor. Answer clearly and helpfully.",
    installedAt: new Date().toISOString(),
  };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const registry = await readLocalLlmRegistry();
  if (!registry.savedAuthors.includes(LEGACY_AUTHOR)) {
    registry.savedAuthors.push(LEGACY_AUTHOR);
    await writeRegistry(registry);
  }
  return true;
}
