import { existsSync } from "node:fs";
import path from "node:path";
import {
  addLocalLlmAuthor,
  deleteInstalledLocalLlmModel,
  findInstalledLocalLlmModel,
  getInstallJobStatus,
  listHfGgufFilenames,
  listHfModelsByAuthor,
  listInstalledLocalLlmModels,
  listLocalLlmAuthors,
  parseLocalLlmRouteModelId,
  startLocalLlmInstall,
  type HfModelSummary,
  type InstallJobStatus,
  type LocalLlmInstalledModel,
} from "./local-llm-store.js";
import { groupGgufFilenames, type GgufGroupOption } from "./local-llm-gguf-group.js";
import { getLocalVlmRootDir } from "../paths.js";


export const DEFAULT_OFFLINE_VLM_REPO = "Rizwan313/Qwen3-VL-Embedding-2B-GGUF";
export const DEFAULT_OFFLINE_VLM_AUTHOR = "Rizwan313";


/** 视觉模型 id：local-vlm/{author}/{slug} */
export function buildLocalVlmModelId(author: string, modelSlug: string): string {
  return `local-vlm/${author.trim()}/${modelSlug.trim()}`;
}


export function normalizeLocalVlmModelId(rawId: string): string {
  const trimmed = rawId.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("local-vlm/")) {
    return trimmed;
  }
  if (trimmed.includes("/")) {
    return `local-vlm/${trimmed}`;
  }
  return trimmed;
}


export function parseLocalVlmRouteModelId(rawParam: string): string {
  const parsed = parseLocalLlmRouteModelId(rawParam);
  return parsed.startsWith("local-vlm/") ? parsed : normalizeLocalVlmModelId(parsed);
}


/** 将 local-vlm 安装目录同步为 sidecar 权重目录（扁平 gguf+mmproj） */
export async function syncLocalVlmWeightsSymlink(model: LocalLlmInstalledModel): Promise<string> {
  const weightsDir = path.join(getLocalVlmRootDir(), "weights");
  const { mkdir, readdir, copyFile, rm } = await import("node:fs/promises");
  await mkdir(weightsDir, { recursive: true });
  const existing = await readdir(weightsDir).catch(() => [] as string[]);
  for (const name of existing) {
    if (name.toLowerCase().endsWith(".gguf")) {
      await rm(path.join(weightsDir, name), { force: true });
    }
  }
  for (const filename of model.filenames) {
    const base = path.basename(filename.replace(/\\/g, "/"));
    const source = path.join(model.dir, base);
    if (!existsSync(source)) {
      continue;
    }
    await copyFile(source, path.join(weightsDir, base));
  }
  return weightsDir;
}


/** HF 视觉仓库列表（偏 GGUF / vision / embedding） */
export async function listHfVlmModelsByAuthor(author: string): Promise<HfModelSummary[]> {
  const models = await listHfModelsByAuthor(author);
  const visionLike = models.filter((item) => {
    const hay = `${item.repoId} ${item.displayName}`.toLowerCase();
    return hay.includes("vl")
      || hay.includes("vision")
      || hay.includes("embedding")
      || hay.includes("qwen3");
  });
  if (visionLike.length > 0) {
    return visionLike;
  }
  return models;
}


function pickMatchingMmproj(mainGroupKey: string, mmprojFiles: string[]): string | undefined {
  const quantMatch = mainGroupKey.match(/q\d+_[a-z0-9]+/i)?.[0]?.toLowerCase();
  if (quantMatch) {
    const matched = mmprojFiles.find((file) => path.basename(file).toLowerCase().includes(quantMatch));
    if (matched) {
      return matched;
    }
  }
  return mmprojFiles[0];
}


/** 列出视觉 GGUF 组（自动附带同档位 mmproj） */
export async function listHfVlmGgufGroups(repoId: string): Promise<GgufGroupOption[]> {
  const files = await listHfGgufFilenames(repoId);
  const mmprojFiles = files.filter((file) => path.basename(file).toLowerCase().includes("mmproj"));
  const mainFiles = files.filter((file) => !path.basename(file).toLowerCase().includes("mmproj"));
  const groups = groupGgufFilenames(mainFiles);
  for (const group of groups) {
    const mmproj = pickMatchingMmproj(group.groupKey, mmprojFiles);
    if (mmproj && !group.filenames.includes(mmproj)) {
      group.filenames.push(mmproj);
    }
  }
  return groups.filter((group) => group.filenames.some((file) => !path.basename(file).toLowerCase().includes("mmproj")));
}


async function withVlmInstallRoot<T>(task: () => Promise<T>): Promise<T> {
  const previous = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = getLocalVlmRootDir();
  try {
    return await task();
  } finally {
    if (previous === undefined) {
      delete process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
    } else {
      process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previous;
    }
  }
}


export async function listLocalVlmAuthors(): Promise<string[]> {
  return withVlmInstallRoot(() => listLocalLlmAuthors());
}


export async function addLocalVlmAuthor(author: string): Promise<string[]> {
  return withVlmInstallRoot(() => addLocalLlmAuthor(author));
}


export async function listInstalledLocalVlmModels(): Promise<LocalLlmInstalledModel[]> {
  const models = await withVlmInstallRoot(() => listInstalledLocalLlmModels());
  return models.map((item) => ({
    ...item,
    id: buildLocalVlmModelId(item.author, item.modelSlug),
  }));
}


export async function findInstalledLocalVlmModel(modelId: string): Promise<LocalLlmInstalledModel | null> {
  const normalized = normalizeLocalVlmModelId(modelId);
  const legacyId = normalized.replace(/^local-vlm\//, "local-llm/");
  const model = await withVlmInstallRoot(() => findInstalledLocalLlmModel(legacyId));
  if (!model) {
    return null;
  }
  return { ...model, id: normalized };
}


export function startLocalVlmInstall(options: {
  author: string;
  repoId: string;
  ggufGroupKey?: string;
  filenames?: string[];
  displayName?: string;
}): string {
  const previous = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = getLocalVlmRootDir();
  try {
    return startLocalLlmInstall({
      ...options,
      defaultPrompt: "Offline vision embedding model for ChattingCursor.",
    });
  } finally {
    if (previous === undefined) {
      delete process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
    } else {
      process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previous;
    }
  }
}


export async function deleteInstalledLocalVlmModel(modelId: string): Promise<void> {
  const normalized = normalizeLocalVlmModelId(modelId);
  const legacyId = normalized.replace(/^local-vlm\//, "local-llm/");
  await withVlmInstallRoot(() => deleteInstalledLocalLlmModel(legacyId));
}


export { getInstallJobStatus, type InstallJobStatus, type LocalLlmInstalledModel as LocalVlmInstalledModel };
