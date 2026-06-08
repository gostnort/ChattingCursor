import type { LaneStatus } from "./resource-scheduler.js";
import { killProcessListeningOnPort } from "./local-llm-lifecycle.js";
import {
  isPilotTtsSidecarScriptPresent,
  isPilotTtsUpstreamPresent,
  isPilotTtsWeightsReady,
  resolvePilotTtsWebuiPort,
} from "./pilot-tts-paths.js";
import { readSchedulerUserSettings } from "./scheduler-settings.js";


const DEFAULT_PILOT_API_PORT = 4323;
let pilotLaneStatus: LaneStatus = "idle";
let pilotReservedVramGb = 3;
let pilotUsedVramGb = 0;
let pilotSpawnPromise: Promise<void> | null = null;
let pilotSidecarActive = false;
let webuiSpawnPromise: Promise<void> | null = null;
let webuiActive = false;
let warmGpuPromise: Promise<{
  ok: boolean;
  estimatedVramGb?: number;
  message?: string;
}> | null = null;


/** Bridge 薄 sidecar 脚本（4323 朗读 API） */
export function isPilotTtsInstallPresent(): boolean {
  return isPilotTtsSidecarScriptPresent();
}


export { resolvePilotTtsInstallPhase } from "./pilot-tts-paths.js";


export function isPilotTtsUpstreamInstalled(): boolean {
  return isPilotTtsUpstreamPresent();
}


export function getPilotTtsReservedVramGb(): number {
  return pilotReservedVramGb;
}


export function setPilotTtsReservedVramGb(value: number): void {
  if (Number.isFinite(value) && value > 0) {
    pilotReservedVramGb = value;
  }
}


export function getPilotTtsUsedVramGb(): number {
  return pilotUsedVramGb;
}


export function getPilotTtsLaneStatus(): LaneStatus {
  return pilotLaneStatus;
}


export function isPilotTtsSidecarActive(): boolean {
  return pilotSidecarActive;
}


export function isPilotTtsWebuiActive(): boolean {
  return webuiActive;
}


export function resolvePilotTtsPort(): number {
  const raw = process.env.PILOT_TTS_PORT?.trim();
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_PILOT_API_PORT;
}


export function resolvePilotTtsBaseUrl(): string {
  const host = process.env.PILOT_TTS_HOST?.trim() || "127.0.0.1";
  return `http://${host}:${resolvePilotTtsPort()}`;
}


export { resolvePilotTtsWebuiUrl, resolvePilotTtsWebuiPort } from "./pilot-tts-paths.js";


/** 探测 4323 Bridge 朗读 API */
export async function probePilotTtsHealth(): Promise<{
  ok: boolean;
  weightsReady: boolean;
  gpuLoaded: boolean;
  upstreamPresent: boolean;
  loadError?: string;
  message?: string;
}> {
  try {
    const response = await fetch(`${resolvePilotTtsBaseUrl()}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return {
        ok: false,
        weightsReady: isPilotTtsWeightsReady(),
        gpuLoaded: false,
        upstreamPresent: isPilotTtsUpstreamPresent(),
        message: `朗读服务 HTTP ${response.status}`,
      };
    }
    const payload = await response.json() as {
      weightsReady?: boolean;
      gpuLoaded?: boolean;
      upstreamPresent?: boolean;
      estimatedVramGb?: number;
      loadError?: string | null;
      message?: string;
    };
    const weightsReady = payload.weightsReady === true || isPilotTtsWeightsReady();
    const upstreamPresent = payload.upstreamPresent === true || isPilotTtsUpstreamPresent();
    if (payload.gpuLoaded) {
      const used = Number(payload.estimatedVramGb);
      pilotUsedVramGb = Number.isFinite(used) && used > 0 ? used : pilotReservedVramGb;
    }
    const loadError = typeof payload.loadError === "string" ? payload.loadError.trim() : undefined;
    return {
      ok: true,
      weightsReady,
      gpuLoaded: payload.gpuLoaded === true,
      upstreamPresent,
      loadError: loadError || undefined,
      message: payload.message,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      weightsReady: isPilotTtsWeightsReady(),
      gpuLoaded: false,
      upstreamPresent: isPilotTtsUpstreamPresent(),
      message,
    };
  }
}


function resolvePilotStartFailureMessage(health: {
  ok: boolean;
  weightsReady: boolean;
  gpuLoaded: boolean;
  loadError?: string;
  message?: string;
}, warmMessage?: string): string {
  if (!health.ok) {
    return health.message ?? "朗读服务未响应，请确认 Bridge 已启动并重试。";
  }
  if (!health.weightsReady) {
    return "语音权重未就绪，请运行 pilot_tts/install.bat 或点击「安装 PilotTTS」下载权重。";
  }
  if (!health.gpuLoaded) {
    if (warmMessage?.trim()) {
      return warmMessage.trim();
    }
    if (health.loadError?.trim()) {
      return health.loadError.trim();
    }
    return "朗读服务已启动，但 GPU 加载失败；请查看显存是否充足或重启 Bridge 后重试。";
  }
  return "朗读服务已就绪";
}


export function isPilotTtsGpuWarming(): boolean {
  return warmGpuPromise !== null;
}


/** 后台 GPU 预热，不阻塞 HTTP 处理器 */
export function schedulePilotTtsGpuWarm(): void {
  void warmPilotTtsGpu().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pilot-tts] 后台 GPU 预热异常：${message}`);
  });
}


/** 用户勾选「启用朗读 API」：启动 sidecar；GPU 预热在后台进行 */
export async function startPilotTtsService(): Promise<{
  ok: boolean;
  warming?: boolean;
  pilotStatus: LaneStatus;
  weightsReady: boolean;
  gpuLoaded: boolean;
  message: string;
}> {
  if (!isPilotTtsInstallPresent()) {
    throw new Error("尚未安装 PilotTTS，请先在语音页点击「安装 PilotTTS」。");
  }
  await ensurePilotTtsSidecarStarted();
  let health = await probePilotTtsHealth();
  if (!health.ok) {
    pilotSidecarActive = false;
    pilotLaneStatus = "failed";
    return {
      ok: false,
      pilotStatus: pilotLaneStatus,
      weightsReady: health.weightsReady,
      gpuLoaded: false,
      message: resolvePilotStartFailureMessage(health),
    };
  }
  pilotSidecarActive = true;
  if (!isPilotTtsUpstreamPresent()) {
    pilotLaneStatus = "degraded";
    return {
      ok: false,
      pilotStatus: pilotLaneStatus,
      weightsReady: health.weightsReady,
      gpuLoaded: false,
      message: "上游代码未安装，请完成 PilotTTS 安装。",
    };
  }
  if (!health.weightsReady) {
    pilotLaneStatus = "degraded";
    return {
      ok: false,
      pilotStatus: pilotLaneStatus,
      weightsReady: false,
      gpuLoaded: false,
      message: resolvePilotStartFailureMessage(health),
    };
  }
  if (!health.gpuLoaded) {
    schedulePilotTtsGpuWarm();
    pilotLaneStatus = "degraded";
    return {
      ok: true,
      warming: true,
      pilotStatus: pilotLaneStatus,
      weightsReady: true,
      gpuLoaded: false,
      message: "朗读 API 已启动，GPU 加载中…",
    };
  }
  pilotUsedVramGb = getPilotTtsUsedVramGb() || pilotReservedVramGb;
  pilotLaneStatus = "ready";
  return {
    ok: true,
    pilotStatus: pilotLaneStatus,
    weightsReady: true,
    gpuLoaded: true,
    message: "朗读服务运行中",
  };
}


async function executeWarmPilotTtsGpu(): Promise<{
  ok: boolean;
  estimatedVramGb?: number;
  message?: string;
}> {
  try {
    const response = await fetch(`${resolvePilotTtsBaseUrl()}/load`, {
      method: "POST",
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) {
      const body = await response.text();
      let message = body.slice(0, 400);
      try {
        const parsed = JSON.parse(body) as { detail?: string | { msg?: string } };
        if (typeof parsed.detail === "string") {
          message = parsed.detail;
        } else if (parsed.detail && typeof parsed.detail === "object" && parsed.detail.msg) {
          message = parsed.detail.msg;
        }
      } catch {
        // 保留原始文本
      }
      return { ok: false, message: message.trim() || `GPU 加载 HTTP ${response.status}` };
    }
    const payload = await response.json() as { estimatedVramGb?: number };
    const used = Number(payload.estimatedVramGb);
    const estimatedVramGb = Number.isFinite(used) && used > 0 ? used : pilotReservedVramGb;
    pilotUsedVramGb = estimatedVramGb;
    return { ok: true, estimatedVramGb };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }
}


/** 车道 1：请求 sidecar 将权重载入 GPU（并发调用共享同一 Promise） */
export async function warmPilotTtsGpu(): Promise<{
  ok: boolean;
  estimatedVramGb?: number;
  message?: string;
}> {
  if (!warmGpuPromise) {
    warmGpuPromise = executeWarmPilotTtsGpu()
      .then((result) => {
        if (result.ok) {
          pilotUsedVramGb = result.estimatedVramGb ?? pilotReservedVramGb;
          if (pilotSidecarActive) {
            pilotLaneStatus = "ready";
          }
        } else if (pilotSidecarActive) {
          pilotLaneStatus = "failed";
          console.error(`[pilot-tts] GPU 预热失败：${result.message ?? "未知"}`);
        }
        return result;
      })
      .finally(() => {
        warmGpuPromise = null;
      });
  }
  return warmGpuPromise;
}


export async function ensurePilotTtsSidecarStarted(): Promise<void> {
  const health = await probePilotTtsHealth();
  if (health.ok) {
    pilotSidecarActive = true;
    return;
  }
  if (!pilotSpawnPromise) {
    pilotSpawnPromise = (async () => {
      killProcessListeningOnPort(resolvePilotTtsPort());
      const { spawnPilotTtsServer } = await import("./pilot-tts-spawn.js");
      await spawnPilotTtsServer();
      const afterSpawn = await probePilotTtsHealth();
      if (!afterSpawn.ok) {
        pilotSidecarActive = false;
        throw new Error(afterSpawn.message ?? "朗读服务启动后未响应 /health");
      }
      pilotSidecarActive = true;
    })().finally(() => {
      pilotSpawnPromise = null;
    });
  }
  await pilotSpawnPromise;
}


export async function ensurePilotTtsWebuiStarted(): Promise<void> {
  const { probePilotTtsWebui, spawnPilotTtsWebui } = await import("./pilot-tts-webui-spawn.js");
  const probe = await probePilotTtsWebui();
  if (probe.ok) {
    webuiActive = true;
    return;
  }
  if (!webuiSpawnPromise) {
    webuiSpawnPromise = spawnPilotTtsWebui().then(() => {
      webuiActive = true;
    }).finally(() => {
      webuiSpawnPromise = null;
    });
  }
  await webuiSpawnPromise;
}


export async function stopPilotTtsWebui(): Promise<void> {
  webuiSpawnPromise = null;
  webuiActive = false;
  killProcessListeningOnPort(resolvePilotTtsWebuiPort());
  const waitMs = process.platform === "win32" ? 1200 : 400;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}


/** Bridge 启动后：若用户曾启用朗读 API，后台启动 sidecar 与 GPU 预热 */
export async function maybeAutoStartPilotTtsApiFromSettings(): Promise<void> {
  const settings = await readSchedulerUserSettings();
  if (!settings.pilotTtsApiEnabled || !settings.pilotTtsEnabled) {
    return;
  }
  if (!isPilotTtsInstallPresent()) {
    return;
  }
  const health = await probePilotTtsHealth();
  if (health.ok && health.gpuLoaded) {
    pilotSidecarActive = true;
    pilotLaneStatus = "ready";
    return;
  }
  void startPilotTtsService().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pilot-tts] 自动启动朗读 API 异常：${message}`);
  });
}


export async function releasePilotTtsLane(): Promise<void> {
  pilotSpawnPromise = null;
  webuiSpawnPromise = null;
  warmGpuPromise = null;
  pilotSidecarActive = false;
  webuiActive = false;
  pilotLaneStatus = "idle";
  pilotUsedVramGb = 0;
  killProcessListeningOnPort(resolvePilotTtsPort());
  killProcessListeningOnPort(resolvePilotTtsWebuiPort());
  const waitMs = process.platform === "win32" ? 1200 : 400;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}
