import { execSync, spawn, type ChildProcess } from "node:child_process";

import { existsSync } from "node:fs";

import { readFile, writeFile, mkdir } from "node:fs/promises";

import path from "node:path";

import process from "node:process";

import { getPilotTtsRootDir } from "./pilot-tts-paths.js";





export type PilotTtsInstallJob = {

  jobId: string;

  state: "running" | "done" | "error";

  progress: string;

  logTail?: string;

  error?: string;

};





const jobs = new Map<string, PilotTtsInstallJob>();

let activeInstall: ChildProcess | null = null;



const WINDOWS_INSTALL_HINT =

  "若出现 pynini / WeTextProcessing 相关编译错误，多为误装上游完整 requirements。" +

  "请删除 pilot_tts\\.venv 后，在「本地 → 语音」重新安装；" +

  "本安装使用 requirements-inference.txt（不含 WeTextProcessing），并优先 Python 3.10/3.11。" +

  "若本机没有 3.10，请从 python.org 安装 Python 3.10 并勾选「py launcher」。";





function installScriptPath(): string {

  return path.join(getPilotTtsRootDir(), "install.py");

}





function jobLogPath(jobId: string): string {

  return path.join(getPilotTtsRootDir(), ".install-logs", `${jobId}.log`);

}





/** Windows 上优先用 py -3.10 / -3.11，与 install.py 一致 */

export function resolvePilotTtsInstallPython(): string {

  if (process.platform !== "win32") {

    return "python3";

  }

  for (const flag of ["-3.10", "-3.11"] as const) {

    try {

      const out = execSync(`py ${flag} -c "import sys; print(sys.executable)"`, {

        encoding: "utf8",

        windowsHide: true,

        timeout: 15_000,

      }).trim();

      if (out) {

        return out;

      }

    } catch {

      continue;

    }

  }

  return "python";

}





function logTailSuggestsPynini(tail: string): boolean {

  const lowered = tail.toLowerCase();

  return (

    lowered.includes("pynini") ||

    lowered.includes("wetextprocessing") ||

    lowered.includes("d8021") ||

    lowered.includes("-wno-register") ||

    lowered.includes("failed building wheel")

  );

}





function formatPilotInstallError(tail: string, exitCode: number | null): string {

  if (logTailSuggestsPynini(tail)) {

    return WINDOWS_INSTALL_HINT;

  }

  const hintLine = tail

    .split(/\r?\n/)

    .map((line) => line.trim())

    .filter((line) => line.startsWith("[hint]"))

    .pop();

  if (hintLine) {

    return hintLine.replace(/^\[hint\]\s*/, "");

  }

  const lastError = tail

    .split(/\r?\n/)

    .map((line) => line.trim())

    .filter((line) => line.startsWith("[error]"))

    .pop();

  if (lastError) {

    return lastError.replace(/^\[error\]\s*/, "");

  }

  return tail.slice(-2000) || `安装失败（exit ${exitCode ?? "?"}）`;

}





/** 启动 GitHub + HF 完整安装 */

export function startPilotTtsInstall(reset: boolean = false): string {

  if (activeInstall && activeInstall.exitCode === null) {

    throw new Error("已有安装任务在进行中");

  }

  const script = installScriptPath();

  if (!existsSync(script)) {

    throw new Error(`未找到 ${script}`);

  }

  const jobId = `pilot-install-${Date.now()}`;

  const job: PilotTtsInstallJob = { jobId, state: "running", progress: "排队中…" };

  jobs.set(jobId, job);

  void runInstallJob(jobId, script, reset);

  return jobId;

}





async function runInstallJob(jobId: string, script: string, reset: boolean): Promise<void> {

  const logPath = jobLogPath(jobId);

  await mkdir(path.dirname(logPath), { recursive: true });

  await writeFile(logPath, "", "utf8");

  const python = resolvePilotTtsInstallPython();

  const args = [script];
  if (reset) {
    args.push("--reset");
  }

  const child = spawn(python, args, {

    cwd: getPilotTtsRootDir(),

    env: {

      ...process.env,

      PYTHONIOENCODING: "utf-8",

      PYTHONUTF8: "1",

      PILOT_TTS_INSTALL_NONINTERACTIVE: "1",

    },

    windowsHide: true,

  });

  activeInstall = child;

  const appendLog = async (chunk: Buffer | string): Promise<void> => {

    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");

    const prev = existsSync(logPath) ? await readFile(logPath, "utf8").catch(() => "") : "";

    const merged = `${prev}${text}`.slice(-32_000);

    await writeFile(logPath, merged, "utf8");

    const lastLine = merged.trim().split(/\r?\n/).pop()?.trim() ?? "";

    const current = jobs.get(jobId);

    if (current) {

      jobs.set(jobId, { ...current, progress: lastLine || current.progress, logTail: merged.slice(-4000) });

    }

  };

  child.stdout?.on("data", (chunk) => void appendLog(chunk));

  child.stderr?.on("data", (chunk) => void appendLog(chunk));

  await new Promise<void>((resolve) => {

    child.on("exit", (code) => {

      activeInstall = null;

      void (async () => {

        const tail = existsSync(logPath) ? await readFile(logPath, "utf8") : "";

        const current = jobs.get(jobId);

        if (!current) {

          resolve();

          return;

        }

        if (code === 0) {

          jobs.set(jobId, {

            ...current,

            state: "done",

            progress: "安装完成",

            logTail: tail.slice(-4000),

          });

        } else {

          jobs.set(jobId, {

            ...current,

            state: "error",

            progress: "安装失败",

            error: formatPilotInstallError(tail, code),

            logTail: tail.slice(-4000),

          });

        }

        resolve();

      })();

    });

  });

}





export function getPilotTtsInstallJob(jobId: string): PilotTtsInstallJob | null {

  return jobs.get(jobId) ?? null;

}

