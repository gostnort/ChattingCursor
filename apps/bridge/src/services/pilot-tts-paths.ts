import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { getRepoRootDir } from "../paths.js";


/** PilotTTS sidecar 脚本（4323 朗读 API） */
export function resolvePilotTtsSidecarScriptPath(): string {
  const override = process.env.PILOT_TTS_SERVER_SCRIPT?.trim();
  if (override) {
    return override;
  }
  return path.join(getRepoRootDir(), "pilot_tts", "server", "tts_server.py");
}


/** 由 sidecar 脚本位置推导 pilot_tts 根目录 */
export function resolvePilotTtsRootBesideSidecar(): string | null {
  const script = resolvePilotTtsSidecarScriptPath();
  if (!existsSync(script)) {
    return null;
  }
  return path.resolve(path.dirname(script), "..");
}


/** PilotTTS 目录（含 upstream 克隆） */
export function getPilotTtsRootDir(): string {
  const override = process.env.PILOT_TTS_ROOT?.trim();
  if (override) {
    return override;
  }
  const beside = resolvePilotTtsRootBesideSidecar();
  if (beside) {
    return beside;
  }
  return path.join(getRepoRootDir(), "pilot_tts");
}


function upstreamHasWebui(upstreamDir: string): boolean {
  return existsSync(path.join(upstreamDir, "webui.py"));
}


function resolveExistingUpstreamDir(): string | null {
  const candidates: string[] = [];
  candidates.push(path.join(getPilotTtsRootDir(), "upstream"));
  const beside = resolvePilotTtsRootBesideSidecar();
  if (beside) {
    candidates.push(path.join(beside, "upstream"));
  }
  candidates.push(path.join(getRepoRootDir(), "pilot_tts", "upstream"));
  for (const candidate of candidates) {
    if (upstreamHasWebui(candidate)) {
      return candidate;
    }
  }
  return null;
}


export function getPilotTtsUpstreamDir(): string {
  const override = process.env.PILOT_TTS_UPSTREAM_DIR?.trim();
  if (override) {
    return override;
  }
  const existing = resolveExistingUpstreamDir();
  if (existing) {
    return existing;
  }
  return path.join(getPilotTtsRootDir(), "upstream");
}


export function getPilotTtsWeightsDir(): string {
  const override = process.env.PILOT_TTS_WEIGHTS_DIR?.trim();
  if (override) {
    return override;
  }
  return path.join(getPilotTtsUpstreamDir(), "pretrained_models");
}


export function resolvePilotTtsWebuiPort(): number {
  const raw = process.env.PILOT_TTS_WEBUI_PORT?.trim();
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 8090;
}


export function resolvePilotTtsWebuiUrl(): string {
  const host = process.env.PILOT_TTS_WEBUI_HOST?.trim() || "127.0.0.1";
  return `http://${host}:${resolvePilotTtsWebuiPort()}`;
}


export function isPilotTtsSidecarScriptPresent(): boolean {
  return existsSync(resolvePilotTtsSidecarScriptPath());
}


export function isPilotTtsUpstreamPresent(): boolean {
  return upstreamHasWebui(getPilotTtsUpstreamDir());
}


export function isPilotTtsWeightsReady(): boolean {
  const weights = getPilotTtsWeightsDir();
  const checkpointOk =
    existsSync(path.join(weights, "pilot_tts.pt"))
    || existsSync(path.join(weights, "pilot_tts_instruct.pt"));
  const w2vConfig = path.join(weights, "w2v-bert-2.0", "config.json");
  if (!checkpointOk || !existsSync(w2vConfig)) {
    return false;
  }
  try {
    return statSync(w2vConfig).size > 0;
  } catch {
    return false;
  }
}


export function resolvePilotTtsWebuiScript(): string {
  return path.join(getPilotTtsUpstreamDir(), "webui.py");
}


export type PilotTtsInstallPhase =
  | "missing"
  | "partial"
  | "needs_weights"
  | "ready_no_gpu"
  | "ready";


export function resolvePilotTtsInstallPhase(input: {
  sidecarPresent: boolean;
  upstreamPresent: boolean;
  weightsReady: boolean;
  gpuLoaded: boolean;
}): PilotTtsInstallPhase {
  if (!input.sidecarPresent && !input.upstreamPresent) {
    return "missing";
  }
  if (!input.upstreamPresent) {
    return "partial";
  }
  if (!input.weightsReady) {
    return "needs_weights";
  }
  if (!input.gpuLoaded) {
    return "ready_no_gpu";
  }
  return "ready";
}


export function getPilotTtsInstallSnapshot(): {
  sidecarPresent: boolean;
  upstreamPresent: boolean;
  weightsReady: boolean;
  upstreamDir: string;
  weightsDir: string;
} {
  return {
    sidecarPresent: isPilotTtsSidecarScriptPresent(),
    upstreamPresent: isPilotTtsUpstreamPresent(),
    weightsReady: isPilotTtsWeightsReady(),
    upstreamDir: getPilotTtsUpstreamDir(),
    weightsDir: getPilotTtsWeightsDir(),
  };
}
