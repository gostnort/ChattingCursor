import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import {
  getPilotTtsRootDir,
  getPilotTtsUpstreamDir,
  getPilotTtsWeightsDir,
  resolvePilotTtsSidecarScriptPath,
} from "./pilot-tts-paths.js";
import { resolvePilotTtsPort } from "./pilot-tts-lifecycle.js";
import { readSchedulerUserSettings } from "./scheduler-settings.js";


function readEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}


function resolvePilotTtsPythonExecutable(): string {
  const override = readEnv("PILOT_TTS_PYTHON");
  if (override) {
    return override;
  }
  const rootDir = getPilotTtsRootDir();
  const venvWin = path.join(rootDir, ".venv", "Scripts", "python.exe");
  const venvUnix = path.join(rootDir, ".venv", "bin", "python");
  if (existsSync(venvWin)) {
    return venvWin;
  }
  if (existsSync(venvUnix)) {
    return venvUnix;
  }
  
  throw new Error(`未找到 PilotTTS 虚拟环境。请运行 pilot_tts/install.bat 创建虚拟环境。（预期路径: ${venvWin} 或 ${venvUnix}）`);
}


/** 启动 PilotTTS HTTP sidecar 并等待 /health */
export async function spawnPilotTtsServer(): Promise<void> {
  const script = resolvePilotTtsSidecarScriptPath();
  if (!existsSync(script)) {
    throw new Error(`未找到 PilotTTS sidecar：${script}。请运行 pilot_tts/install.bat。`);
  }
  const python = resolvePilotTtsPythonExecutable();
  const host = readEnv("PILOT_TTS_HOST") || "127.0.0.1";
  const port = resolvePilotTtsPort();
  const weightsDir = getPilotTtsWeightsDir();
  const upstreamDir = getPilotTtsUpstreamDir();
  const settings = await readSchedulerUserSettings();
  const promptWavFromSettings = settings.pilotTtsPromptWavPath.trim();
  const child = spawn(python, [script], {
    cwd: upstreamDir,
    env: {
      ...process.env,
      PILOT_TTS_HOST: host,
      PILOT_TTS_PORT: String(port),
      PILOT_TTS_UPSTREAM_DIR: upstreamDir,
      PILOT_TTS_WEIGHTS_DIR: weightsDir,
      PILOT_TTS_RESERVED_VRAM_GB: readEnv("PILOT_TTS_RESERVED_VRAM_GB") || "3",
      PILOT_TTS_AUTO_LOAD: readEnv("PILOT_TTS_AUTO_LOAD") || "0",
      PILOT_TTS_PROMPT_WAV: promptWavFromSettings || readEnv("PILOT_TTS_PROMPT_WAV") || "",
    },
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + 90_000;
  const base = `http://${host}:${port}`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        return;
      }
    } catch {
      // 等待就绪
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`PilotTTS sidecar 在 90 秒内未响应（端口 ${port}）。`);
}
