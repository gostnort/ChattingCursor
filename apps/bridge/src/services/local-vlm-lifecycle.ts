import process from "node:process";
import { killProcessListeningOnPort } from "./local-llm-lifecycle.js";


const DEFAULT_VLM_PORT = 4325;
let vlmSpawnPromise: Promise<void> | null = null;
let vlmActive = false;


export function resetLocalVlmSpawnState(): void {
  vlmSpawnPromise = null;
}


export function resolveLocalVlmPort(): number {
  const raw = process.env.LOCAL_VLM_PORT?.trim();
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_VLM_PORT;
}


/** 强制结束 VLM sidecar，释放 RAM */
export async function forceStopLocalVlmSidecar(): Promise<{ unloaded: boolean }> {
  resetLocalVlmSpawnState();
  vlmActive = false;
  const killedPort = killProcessListeningOnPort(resolveLocalVlmPort());
  if (killedPort) {
    const waitMs = process.platform === "win32" ? 1500 : 500;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return { unloaded: killedPort };
}


/** 确保 VLM sidecar 已启动（RAM/CPU，n_gpu_layers=0） */
export async function ensureLocalVlmSidecarStarted(): Promise<void> {
  if (vlmActive) {
    return;
  }
  if (!vlmSpawnPromise) {
    vlmSpawnPromise = startLocalVlmSidecar().finally(() => {
      vlmSpawnPromise = null;
    });
  }
  await vlmSpawnPromise;
}


async function startLocalVlmSidecar(): Promise<void> {
  const { spawnLocalVlmServer } = await import("./local-vlm-spawn.js");
  await spawnLocalVlmServer();
  vlmActive = true;
}
