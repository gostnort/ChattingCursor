import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { killProcessListeningOnPort } from "./local-llm-lifecycle.js";
import {
  getPilotTtsRootDir,
  getPilotTtsUpstreamDir,
  isPilotTtsUpstreamPresent,
  resolvePilotTtsWebuiPort,
  resolvePilotTtsWebuiScript,
  resolvePilotTtsWebuiUrl,
} from "./pilot-tts-paths.js";


const WEBUI_START_TIMEOUT_MS = 240_000;
const WEBUI_PROBE_TIMEOUT_MS = 8_000;


function resolvePilotPython(): string {
  const override = process.env.PILOT_TTS_PYTHON?.trim();
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


/** 将底层错误转为用户可读中文 */
export function mapPilotWebuiError(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  if (!raw) {
    return "配置界面启动失败，请稍后重试。";
  }
  if (/upstream|webui\.py|未安装.*上游/i.test(raw)) {
    return "未安装 PilotTTS 上游。请先在语音页点击「安装 PilotTTS」。";
  }
  if (/python|解释器|ENOENT|不是内部或外部命令|not found/i.test(raw)) {
    return "未找到可用的 Python。请先运行 pilot_tts/install.bat 创建虚拟环境。";
  }
  if (/EADDRINUSE|端口.*占用|address already in use/i.test(raw)) {
    return "配置界面端口被占用。请关闭占用该端口的程序后重试。";
  }
  if (/超时|未响应|秒内未响应/i.test(raw)) {
    return "配置界面启动超时。请确认已安装 Gradio 依赖，或稍后重试。";
  }
  if (/ModuleNotFoundError|No module named/i.test(raw)) {
    return "缺少 WebUI 依赖。请重新运行「安装 PilotTTS」或 pilot_tts/install.bat。";
  }
  return raw
    .replace(/\b8090\b/g, "配置端口")
    .replace(/\b4324\b/g, "配置端口")
    .replace(/\bsidecar\b/gi, "朗读服务");
}


function assertWebuiPrerequisites(): { python: string; script: string; upstream: string } {
  if (!isPilotTtsUpstreamPresent()) {
    throw new Error("未安装 PilotTTS 上游（缺少 upstream/webui.py）。请先点击「安装 PilotTTS」。");
  }
  const script = resolvePilotTtsWebuiScript();
  if (!existsSync(script)) {
    throw new Error("未找到配置界面程序（upstream/webui.py）。请先完成「安装 PilotTTS」。");
  }
  const python = resolvePilotPython();
  if (python.includes(path.sep) && !existsSync(python)) {
    throw new Error(`未找到 Python 解释器：${python}。请先运行 pilot_tts/install.bat。`);
  }
  return { python, script, upstream: getPilotTtsUpstreamDir() };
}


function isPortListenError(stderr: string): boolean {
  return /EADDRINUSE|address already in use|端口|WinError 10048/i.test(stderr);
}


/** 启动官方 Gradio webui.py（供配置与试听） */
export async function spawnPilotTtsWebui(): Promise<void> {
  const { python, script, upstream } = assertWebuiPrerequisites();
  const port = resolvePilotTtsWebuiPort();
  killProcessListeningOnPort(port);
  const portWaitMs = process.platform === "win32" ? 1500 : 500;
  await new Promise((resolve) => setTimeout(resolve, portWaitMs));
  let stderrTail = "";
  let childExited = false;
  let childExitCode: number | null = null;
  const child = spawn(python, [script], {
    cwd: upstream,
    env: {
      ...process.env,
      GRADIO_SERVER_NAME: process.env.PILOT_TTS_WEBUI_HOST?.trim() || "127.0.0.1",
      GRADIO_SERVER_PORT: String(port),
      SERVER_NAME: process.env.PILOT_TTS_WEBUI_HOST?.trim() || "127.0.0.1",
      SERVER_PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    stderrTail = `${stderrTail}${text}`.slice(-8000);
  });
  child.on("error", (spawnError: Error) => {
    stderrTail = `${stderrTail}\n${spawnError.message}`.slice(-8000);
  });
  child.on("exit", (code) => {
    childExited = true;
    childExitCode = code;
  });
  child.unref();
  const deadline = Date.now() + WEBUI_START_TIMEOUT_MS;
  const base = resolvePilotTtsWebuiUrl();
  while (Date.now() < deadline) {
    if (childExited && childExitCode !== 0 && childExitCode !== null) {
      if (isPortListenError(stderrTail)) {
        throw new Error("配置界面端口被占用，无法绑定监听。");
      }
      const detail = stderrTail.trim().slice(-600);
      throw new Error(detail || `配置界面进程异常退出（代码 ${childExitCode}）`);
    }
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(WEBUI_PROBE_TIMEOUT_MS) });
      if (response.ok || response.status === 200 || response.status === 302) {
        return;
      }
    } catch {
      // Gradio 启动较慢
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (isPortListenError(stderrTail)) {
    throw new Error("配置界面端口被占用。请关闭占用该端口的程序后重试。");
  }
  const detail = stderrTail.trim().slice(-400);
  throw new Error(
    detail
      ? `配置界面在 ${WEBUI_START_TIMEOUT_MS / 1000} 秒内未就绪：${detail}`
      : `配置界面在 ${WEBUI_START_TIMEOUT_MS / 1000} 秒内未响应（${base}）。请查看 pilot_tts/upstream 日志。`,
  );
}


export async function probePilotTtsWebui(): Promise<{ ok: boolean; url: string }> {
  const url = resolvePilotTtsWebuiUrl();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(WEBUI_PROBE_TIMEOUT_MS) });
    return { ok: response.ok || response.status < 500, url };
  } catch {
    return { ok: false, url };
  }
}
