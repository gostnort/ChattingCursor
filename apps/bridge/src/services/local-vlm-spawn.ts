import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { getLocalVlmServerScriptPath, getRepoRootDir } from "../paths.js";
import { resolveLocalVlmPort } from "./local-vlm-lifecycle.js";


function readEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}


function resolveLocalVlmPythonExecutable(): string {
  const override = readEnv("LOCAL_VLM_PYTHON") || readEnv("LOCAL_LLM_PYTHON") || readEnv("GEMMA4_PYTHON");
  if (override) {
    return override;
  }
  const venvWin = path.join(getRepoRootDir(), "local_vlm", "server", ".venv", "Scripts", "python.exe");
  const venvUnix = path.join(getRepoRootDir(), "local_vlm", "server", ".venv", "bin", "python");
  if (existsSync(venvWin)) {
    return venvWin;
  }
  if (existsSync(venvUnix)) {
    return venvUnix;
  }
  return process.platform === "win32" ? "python" : "python3";
}


/** 启动 VLM sidecar 子进程（RAM/CPU，n_gpu_layers=0） */
export async function spawnLocalVlmServer(): Promise<void> {
  const python = resolveLocalVlmPythonExecutable();
  const script = getLocalVlmServerScriptPath();
  const host = readEnv("LOCAL_VLM_HOST") || "127.0.0.1";
  const port = resolveLocalVlmPort();
  const weightsDir = readEnv("LOCAL_VLM_WEIGHTS_DIR")
    || path.join(getRepoRootDir(), "local_vlm", "weights");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCAL_VLM_HOST: host,
    LOCAL_VLM_PORT: String(port),
    LOCAL_VLM_WEIGHTS_DIR: weightsDir,
    LOCAL_VLM_N_GPU_LAYERS: "0",
    LOCAL_VLM_DEFER_MODEL_LOAD: readEnv("LOCAL_VLM_DEFER_MODEL_LOAD") || "1",
  };
  const child = spawn(python, [script], {
    cwd: path.dirname(script),
    env,
    stdio: "ignore",
    detached: false,
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + 60_000;
  const base = `http://${host}:${port}`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        return;
      }
    } catch {
      // 等待 sidecar 就绪
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`离线视觉 sidecar 在 60 秒内未响应（端口 ${port}）。请安装 local_vlm/server 依赖与权重。`);
}
