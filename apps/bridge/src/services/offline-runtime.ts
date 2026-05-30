import { resolveOfflineRuntimeId } from "@chatting-cursor/shared";
import {
  ensureLocalLlmSidecarStarted,
  getLocalLlmHealthStatus,
  type LocalLlmLoadState,
  type LocalLlmWeightsStatus,
} from "./local-llm-lifecycle.js";


export type OfflineWarmupSnapshot = {
  modelId: string;
  runtime: string;
  ready: boolean;
  spawning: boolean;
  running: boolean;
  weights?: LocalLlmWeightsStatus;
  loadState?: LocalLlmLoadState;
  error?: string;
  message?: string;
};


/** 汇总离线模型当前状态（不拉起进程） */
export async function getOfflineModelSnapshot(modelId: string): Promise<OfflineWarmupSnapshot> {
  const runtime = resolveOfflineRuntimeId(modelId);
  if (!runtime) {
    return {
      modelId,
      runtime: "unknown",
      ready: false,
      spawning: false,
      running: false,
      message: `未知离线模型：${modelId}`,
    };
  }
  if (runtime === "local-llm") {
    const health = await getLocalLlmHealthStatus(modelId);
    const sidecarWarm =
      health.weights === "ready"
      && health.loadState !== "down"
      && health.loadState !== "error";
    return {
      modelId,
      runtime,
      ready: health.running || (sidecarWarm && health.loadState === "idle"),
      spawning: health.spawning,
      running: health.running,
      weights: health.weights,
      loadState: health.loadState,
      error: health.loadError,
      message: health.running
        ? undefined
        : health.loadState === "idle"
          ? "推理服务已就绪；发送首条消息时将加载 GGUF 模型"
          : health.message,
    };
  }
  return {
    modelId,
    runtime,
    ready: false,
    spawning: false,
    running: false,
    message: `未实现的离线运行时：${runtime}`,
  };
}


/** 确保离线模型推理服务已就绪（按 modelId 路由到对应 runtime） */
export async function ensureOfflineModelReady(modelId: string): Promise<OfflineWarmupSnapshot> {
  const runtime = resolveOfflineRuntimeId(modelId);
  if (!runtime) {
    throw new Error(`未知离线模型：${modelId}`);
  }
  if (runtime === "local-llm") {
    await ensureLocalLlmSidecarStarted(modelId);
    return getOfflineModelSnapshot(modelId);
  }
  throw new Error(`未实现的离线运行时：${runtime}`);
}
