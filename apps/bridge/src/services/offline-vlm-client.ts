import process from "node:process";
import {
  assertOfflineSchedulerAllows,
  isOfflineVlmLoadedForModel,
  markOfflineVlmLoaded,
  planOfflineVlmLoad,
} from "./resource-scheduler.js";
import { ensureLocalVlmSidecarStarted, resolveLocalVlmPort } from "./local-vlm-lifecycle.js";
import { readOfflineVisionSettings } from "./offline-vision-settings.js";
import {
  findInstalledLocalVlmModel,
  listInstalledLocalVlmModels,
  syncLocalVlmWeightsSymlink,
} from "./local-vlm-store.js";


function readEnvFlag(name: string, defaultOn: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return defaultOn;
  }
  if (raw === "0" || raw === "false" || raw === "no") {
    return false;
  }
  return raw === "1" || raw === "true" || raw === "yes";
}


/** 是否启用离线 VLM 车道 3 */
export async function isOfflineVlmEnabled(): Promise<boolean> {
  const env = readEnvFlag("OFFLINE_VLM_ENABLED", true);
  if (!env) {
    return false;
  }
  const settings = await readOfflineVisionSettings();
  return settings.enabled;
}


async function resolveActiveOfflineVlmModelId(offlineLlmModelId: string): Promise<string> {
  const settings = await readOfflineVisionSettings();
  if (settings.selectedModelId) {
    const selected = await findInstalledLocalVlmModel(settings.selectedModelId);
    if (selected?.weightsReady) {
      return selected.id;
    }
  }
  const installed = await listInstalledLocalVlmModels();
  const ready = installed.find((item) => item.weightsReady);
  if (ready) {
    return ready.id;
  }
  throw new Error(
    `未安装离线视觉模型。请在「本地模型 → 视觉模型」安装 ${settings.defaultRepoId}（当前离线 LLM：${offlineLlmModelId}）。`,
  );
}


function resolveVlmBaseUrl(): string {
  const host = process.env.LOCAL_VLM_HOST?.trim() || "127.0.0.1";
  const port = resolveLocalVlmPort();
  return `http://${host}:${port}/v1`;
}


function resolveVlmRamNeedGb(): number {
  const parsed = Number(process.env.LOCAL_VLM_RAM_NEED_GB?.trim());
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 2.5;
}


/** 确保 VLM 已按计划加载并绑定离线 LLM */
export async function ensureOfflineVlmReady(offlineLlmModelId: string): Promise<void> {
  if (!(await isOfflineVlmEnabled())) {
    throw new Error("离线视觉未启用。请在「本地模型 → 视觉模型」勾选启用。");
  }
  assertOfflineSchedulerAllows("加载离线视觉模型");
  const vlmModelId = await resolveActiveOfflineVlmModelId(offlineLlmModelId);
  const model = await findInstalledLocalVlmModel(vlmModelId);
  if (!model?.weightsReady) {
    throw new Error("所选视觉模型权重不完整，请重新安装 GGUF 与 mmproj。");
  }
  await syncLocalVlmWeightsSymlink(model);
  if (!isOfflineVlmLoadedForModel(offlineLlmModelId)) {
    planOfflineVlmLoad(offlineLlmModelId, resolveVlmRamNeedGb());
  }
  await ensureLocalVlmSidecarStarted();
  const baseUrl = resolveVlmBaseUrl();
  const loadResponse = await fetch(`${baseUrl}/load`, { method: "POST", signal: AbortSignal.timeout(120_000) });
  if (!loadResponse.ok) {
    const body = await loadResponse.text();
    throw new Error(`视觉模型加载失败：${body.slice(0, 300)}`);
  }
  markOfflineVlmLoaded(offlineLlmModelId);
}


/** 对图片 data URL 做 embedding，返回向量 */
export async function embedOfflineImage(
  imageDataUrl: string,
  instruction: string,
  signal?: AbortSignal,
): Promise<number[]> {
  const baseUrl = resolveVlmBaseUrl();
  const timeoutMs = Number(process.env.LOCAL_VLM_EMBED_TIMEOUT_MS ?? 120_000);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.LOCAL_VLM_MODEL_ID?.trim() || "local-vlm",
      input: [
        { type: "text", text: instruction },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    }),
    signal: combined,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`视觉 embedding 失败 ${response.status}：${body.slice(0, 400)}`);
  }
  const payload = await response.json() as {
    data?: Array<{ embedding?: number[] }>;
  };
  const vector = payload.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("视觉 embedding 返回为空");
  }
  return vector;
}
