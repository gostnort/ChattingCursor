import { spawnSync } from "node:child_process";
import { cancelAllActiveRuns } from "./active-run-registry.js";
import { forceStopLocalLlmSidecar, resetLocalLlmSpawnState } from "./local-llm-lifecycle.js";
import { forceStopLocalVlmSidecar, resetLocalVlmSpawnState } from "./local-vlm-lifecycle.js";
import {
  getPilotTtsLaneStatus,
  getPilotTtsReservedVramGb,
  maybeAutoStartPilotTtsApiFromSettings,
  setPilotTtsReservedVramGb,
} from "./pilot-tts-lifecycle.js";
import { readSchedulerUserSettings } from "./scheduler-settings.js";
import {
  clearOfflineVlmBindingState,
  getActiveOfflineLlmModelIdState,
  getLlmNGpuLayersOverride,
  getOfflineVlmBindingState,
  isOfflineVlmLoadedForModelState,
  markOfflineVlmLoadedState,
  setActiveOfflineLlmModelId,
  setLlmNGpuLayersOverride,
} from "./scheduler-state.js";


export type LaneStatus = "idle" | "ready" | "skipped" | "failed" | "degraded";


export type GpuProbe = {
  available: boolean;
  totalVramGb: number | null;
  freeVramGb: number | null;
  message?: string;
};


export type AllocationPlan = {
  ok: boolean;
  reason?: string;
  pilotLane?: LaneStatus;
};


export type ResourceSchedulerSnapshot = {
  blocked: boolean;
  blockReason?: string;
  gpu: GpuProbe;
  pilotTts: {
    enabled: boolean;
    status: LaneStatus;
    reservedVramGb: number;
    usedVramGb: number;
  };
  offlineLlm: {
    modelId: string | null;
    nGpuLayers: number | null;
  };
  offlineVlm: {
    boundModelId: string | null;
    loaded: boolean;
  };
};


let schedulerBlocked = false;
let schedulerBlockReason: string | undefined;
let gpuProbeCache: GpuProbe = { available: false, totalVramGb: null, freeVramGb: null };
let pilotTtsEnabled = true;


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


/** 解析 nvidia-smi 显存（GB） */
export function probeGpuVram(): GpuProbe {
  const result = spawnSync(
    "nvidia-smi",
    ["--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    return {
      available: false,
      totalVramGb: null,
      freeVramGb: null,
      message: "未检测到 NVIDIA GPU 或 nvidia-smi 不可用",
    };
  }
  const line = result.stdout.trim().split(/\r?\n/)[0] ?? "";
  const parts = line.split(",").map((item) => item.trim());
  if (parts.length < 2) {
    return {
      available: false,
      totalVramGb: null,
      freeVramGb: null,
      message: "nvidia-smi 输出格式无法解析",
    };
  }
  const totalMb = Number(parts[0]);
  const freeMb = Number(parts[1]);
  if (!Number.isFinite(totalMb) || !Number.isFinite(freeMb)) {
    return {
      available: false,
      totalVramGb: null,
      freeVramGb: null,
      message: "nvidia-smi 显存数值无效",
    };
  }
  return {
    available: true,
    totalVramGb: totalMb / 1024,
    freeVramGb: freeMb / 1024,
  };
}


/** 计划 §〇-A：probeGpu 别名 */
export const probeGpu = probeGpuVram;


/** 车道 2：TTS 预留后的剩余显存用于估算 GPU 层数 */
export function computeOfflineLlmNGpuLayers(ggufGb: number, freeVramGb: number | null): number {
  const envRaw = process.env.LOCAL_LLM_N_GPU_LAYERS?.trim()
    ?? process.env.GEMMA4_N_GPU_LAYERS?.trim()
    ?? "";
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (freeVramGb === null || freeVramGb <= 0) {
    return 0;
  }
  if (freeVramGb >= ggufGb * 1.05) {
    return -1;
  }
  if (freeVramGb < 0.5) {
    return 0;
  }
  const ratio = freeVramGb / Math.max(ggufGb, 0.25);
  if (ratio >= 0.9) {
    return -1;
  }
  return Math.min(80, Math.max(0, Math.round(ratio * 42)));
}


/** 车道 1：启用时预留显存；就绪后按实际占用扣减 */
function getTtsVramDeductionGb(): number {
  if (!pilotTtsEnabled || !gpuProbeCache.available) {
    return 0;
  }
  const lane = getPilotTtsLaneStatus();
  if (lane === "ready") {
    // If TTS is already ready, its VRAM is already occupied and reflected in nvidia-smi's freeVramGb.
    // We don't need to deduct it again.
    return 0;
  }
  return getPilotTtsReservedVramGb();
}


function getFreeVramForOfflineLlm(): number | null {
  if (!gpuProbeCache.available || gpuProbeCache.freeVramGb === null) {
    return null;
  }
  const ttsUsed = getTtsVramDeductionGb();
  return Math.max(0, gpuProbeCache.freeVramGb - ttsUsed);
}


function shouldBlockOfflineForPilotLane(lane: LaneStatus): boolean {
  if (!pilotTtsEnabled || !gpuProbeCache.available) {
    return false;
  }
  if (lane === "failed" || lane === "degraded") {
    return !readEnvFlag("PILOT_TTS_ALLOW_OFFLINE_WITHOUT_PILOT", true);
  }
  return false;
}


/** 车道 1：启动计划（fail-closed） */
export async function planStartup(options: { pilotTtsEnabled?: boolean }): Promise<AllocationPlan> {
  if (options.pilotTtsEnabled !== undefined) {
    pilotTtsEnabled = options.pilotTtsEnabled;
  }
  gpuProbeCache = probeGpuVram();
  schedulerBlocked = false;
  schedulerBlockReason = undefined;
  if (!pilotTtsEnabled) {
    return { ok: true, pilotLane: "skipped" };
  }
  if (!gpuProbeCache.available) {
    return { ok: true, pilotLane: getPilotTtsLaneStatus() };
  }
  if (gpuProbeCache.freeVramGb === null) {
    schedulerBlocked = true;
    schedulerBlockReason = "无法读取 GPU 显存，离线能力已阻塞。";
    return { ok: false, reason: schedulerBlockReason, pilotLane: "failed" };
  }
  const reserved = getPilotTtsReservedVramGb();
  if (gpuProbeCache.freeVramGb < reserved) {
    schedulerBlocked = true;
    schedulerBlockReason = `可用显存约 ${gpuProbeCache.freeVramGb.toFixed(1)} GB，低于 PilotTTS 预留 ${reserved} GB。可关闭 PilotTTS 或释放显存。`;
    return { ok: false, reason: schedulerBlockReason, pilotLane: "failed" };
  }
  const lane = getPilotTtsLaneStatus();
  if (shouldBlockOfflineForPilotLane(lane)) {
    schedulerBlocked = true;
    schedulerBlockReason = lane === "failed"
      ? "朗读服务 GPU 预热失败，离线大模型暂不可用。"
      : "朗读服务未就绪（缺上游/权重/GPU 预热），离线大模型暂不可用。";
    return { ok: false, reason: schedulerBlockReason, pilotLane: lane };
  }
  return { ok: true, pilotLane: lane };
}


/** Bridge 启动：车道 1 TTS 显存优先 */
export async function initializeResourceSchedulerOnBridgeStart(): Promise<ResourceSchedulerSnapshot> {
  const settings = await readSchedulerUserSettings();
  const envPilot = readEnvFlag("PILOT_TTS_ENABLED", true);
  pilotTtsEnabled = settings.pilotTtsEnabled && envPilot;
  setPilotTtsReservedVramGb(settings.pilotTtsReservedVramGb);
  await planStartup({ pilotTtsEnabled });
  void maybeAutoStartPilotTtsApiFromSettings().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pilot-tts] 自动启动朗读 API 失败：${message}`);
  });
  return getResourceSchedulerSnapshot();
}


export function isResourceSchedulerBlocked(): boolean {
  return schedulerBlocked;
}


export function getResourceSchedulerBlockReason(): string | undefined {
  return schedulerBlockReason;
}


/** 离线路径门禁 */
export function assertOfflineSchedulerAllows(reason: string): void {
  if (!schedulerBlocked) {
    return;
  }
  const detail = schedulerBlockReason ?? "资源调度未就绪";
  throw new Error(`${detail}（${reason}）`);
}


/** 准备加载离线 LLM（车道 2）；余量不足则拒绝 */
export function planOfflineLlmLoad(modelId: string, ggufGb: number): number {
  assertOfflineSchedulerAllows("加载离线大模型");
  const freeVram = getFreeVramForOfflineLlm();
  const freeRamGb = probeSystemAvailableRamGb();
  const layers = computeOfflineLlmNGpuLayers(ggufGb, freeVram);
  const minFreeVram = 0.35;
  if (freeVram !== null && freeVram < minFreeVram && layers <= 0) {
    throw new Error(
      `拒绝加载 ${modelId}：TTS 占用后显存余量约 ${freeVram.toFixed(1)} GB，不足以安全加载约 ${ggufGb.toFixed(1)} GB 模型。`,
    );
  }
  if (
    layers <= 0
    && freeRamGb !== null
    && freeRamGb < ggufGb * 0.95
    && ggufGb > 1.5
  ) {
    throw new Error(
      `拒绝加载 ${modelId}：可用内存约 ${freeRamGb.toFixed(1)} GB，模型约需 ${ggufGb.toFixed(1)} GB（CPU 回退）。`,
    );
  }
  setActiveOfflineLlmModelId(modelId);
  setLlmNGpuLayersOverride(layers);
  return layers;
}


export { resolveScheduledLlmNGpuLayersEnv } from "./scheduler-state.js";


/** 车道 3：按需加载 VLM（仅 RAM） */
export function planOfflineVlmLoad(modelId: string, ramNeedGb: number): void {
  assertOfflineSchedulerAllows("加载离线视觉模型");
  if (isOfflineVlmLoadedForModelState(modelId)) {
    return;
  }
  const freeRamGb = probeSystemAvailableRamGb();
  if (freeRamGb !== null && freeRamGb < ramNeedGb) {
    throw new Error(`系统可用内存约 ${freeRamGb.toFixed(1)} GB，加载视觉模型约需 ${ramNeedGb} GB。`);
  }
}


/** 计划 §〇-A：planVlmOnDemand 别名 */
export function planVlmOnDemand(modelId: string, ramNeedGb = 2.5): void {
  planOfflineVlmLoad(modelId, ramNeedGb);
}


export function markOfflineVlmLoaded(modelId: string): void {
  markOfflineVlmLoadedState(modelId);
}


export function clearOfflineVlmBinding(): void {
  clearOfflineVlmBindingState();
}


export function isOfflineVlmLoadedForModel(modelId: string): boolean {
  return isOfflineVlmLoadedForModelState(modelId);
}


/** 释放离线栈：LLM + VLM，不释放 TTS */
export async function releaseOfflineStack(): Promise<{ llmUnloaded: boolean; vlmUnloaded: boolean }> {
  cancelAllActiveRuns();
  resetLocalLlmSpawnState();
  resetLocalVlmSpawnState();
  const llm = await forceStopLocalLlmSidecar();
  const vlm = await forceStopLocalVlmSidecar();
  setActiveOfflineLlmModelId(null);
  setLlmNGpuLayersOverride(null);
  clearOfflineVlmBinding();
  return { llmUnloaded: llm.unloaded, vlmUnloaded: vlm.unloaded };
}


export function getResourceSchedulerSnapshot(): ResourceSchedulerSnapshot {
  return {
    blocked: schedulerBlocked,
    blockReason: schedulerBlockReason,
    gpu: gpuProbeCache,
    pilotTts: {
      enabled: pilotTtsEnabled,
      status: getPilotTtsLaneStatus(),
      reservedVramGb: getPilotTtsReservedVramGb(),
      usedVramGb: getTtsVramDeductionGb(),
    },
    offlineLlm: {
      modelId: getActiveOfflineLlmModelIdState(),
      nGpuLayers: getLlmNGpuLayersOverride(),
    },
    offlineVlm: getOfflineVlmBindingState(),
  };
}


/** 计划 §〇-A：getAllocationState 别名 */
export const getAllocationState = getResourceSchedulerSnapshot;


/** 用 psutil 探测可用 RAM（GB）；失败时回退 PowerShell/sysctl */
export function probeSystemAvailableRamGb(): number | null {
  const python = process.platform === "win32" ? "python" : "python3";
  const script = "import psutil; print(psutil.virtual_memory().available)";
  const psutilProbe = spawnSync(python, ["-c", script], { encoding: "utf8", windowsHide: true });
  if (psutilProbe.status === 0) {
    const bytes = Number(psutilProbe.stdout.trim());
    if (Number.isFinite(bytes) && bytes > 0) {
      return bytes / (1024 ** 3);
    }
  }
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB"],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status === 0) {
      const value = Number(result.stdout.trim());
      if (Number.isFinite(value)) {
        return value / 1024;
      }
    }
    return null;
  }
  try {
    const result = spawnSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" });
    if (result.status === 0) {
      const bytes = Number(result.stdout.trim());
      if (Number.isFinite(bytes)) {
        return bytes / (1024 ** 3);
      }
    }
  } catch {
    return null;
  }
  return null;
}
