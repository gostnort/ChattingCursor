import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { CrewRunResponse } from "@chatting-cursor/shared";
import { resolveChromeEndpoint } from "@chatting-cursor/shared/chrome-endpoint";
import { RUN_CREW_SCRIPT, REPO_ROOT, resolveCrewConfigPath } from "./load-crew.js";


export interface CrewProbeResult {
  python: {
    available: boolean;
    command?: string;
    message?: string;
  };
  crewai: {
    installed: boolean;
    version?: string;
    message?: string;
  };
  chrome: {
    available: boolean;
    endpoint: string;
    pages?: number;
    message?: string;
  };
  exampleConfig: {
    valid: boolean;
    path?: string;
    name?: string;
    message?: string;
  };
  scriptPath?: string;
  timestamp: string;
}


/** 解析 Python 可执行文件（优先项目 .venv） */
export async function resolvePythonCommand(): Promise<string | null> {
  const candidates = process.platform === "win32"
    ? [
      path.join(REPO_ROOT, ".venv", "Scripts", "python.exe"),
      "python",
      "py",
    ]
    : [
      path.join(REPO_ROOT, ".venv", "bin", "python"),
      "python3",
      "python",
    ];
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    if (await probeCommand(candidate, ["--version"])) {
      return candidate;
    }
  }
  return null;
}


/** 探测 crewAI 与 Chrome 9222 环境状态 */
export async function probeCrewEnvironment(): Promise<CrewProbeResult> {
  const python = await resolvePythonCommand();
  const base: CrewProbeResult = {
    python: python
      ? { available: true, command: python }
      : { available: false, message: "未找到 Python，请安装 Python 3.10+ 或运行 pnpm crew:setup" },
    crewai: { installed: false, message: "未检测" },
    chrome: {
      available: false,
      endpoint: resolveChromeEndpoint(),
      message: "未检测",
    },
    exampleConfig: {
      valid: false,
      path: resolveCrewConfigPath("example"),
      message: "未检测",
    },
    scriptPath: RUN_CREW_SCRIPT,
    timestamp: new Date().toISOString(),
  };
  if (!python) {
    return base;
  }
  const statusRun = await runCommand(python, [RUN_CREW_SCRIPT, "--status"]);
  if (statusRun.exitCode !== 0) {
    return {
      ...base,
      exampleConfig: {
        valid: false,
        path: resolveCrewConfigPath("example"),
        message: statusRun.stdout.trim() || statusRun.stderr.trim() || "crewAI 状态脚本执行失败",
      },
    };
  }
  try {
    const parsed = JSON.parse(statusRun.stdout.trim()) as CrewProbeResult;
    return parsed;
  } catch {
    return {
      ...base,
      exampleConfig: {
        valid: false,
        path: resolveCrewConfigPath("example"),
        message: statusRun.stdout.trim() || "crewAI 状态返回无法解析",
      },
    };
  }
}


/** 通过 Python 脚本运行 crew（默认 dry-run） */
export async function runCrew(
  crewName: string,
  inputs: Record<string, string>,
  dryRun = true,
): Promise<CrewRunResponse> {
  const python = await resolvePythonCommand();
  if (!python) {
    return {
      crew: crewName,
      dryRun,
      exitCode: 1,
      output: "Python 不可用",
    };
  }
  const configPath = resolveCrewConfigPath(crewName);
  const tempDir = await mkdtemp(path.join(tmpdir(), "chattingcursor-crew-"));
  const inputsPath = path.join(tempDir, "inputs.json");
  await writeFile(inputsPath, JSON.stringify(inputs), "utf8");
  const args = [
    RUN_CREW_SCRIPT,
    "--config",
    configPath,
    "--inputs-file",
    inputsPath,
  ];
  if (dryRun) {
    args.push("--dry-run");
  } else {
    args.push("--execute");
  }
  const result = await runCommand(python, args);
  await rm(tempDir, { recursive: true, force: true });
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  } catch {
    parsed = undefined;
  }
  return {
    crew: crewName,
    dryRun,
    exitCode: result.exitCode,
    output: result.stdout.trim() || result.stderr.trim(),
    parsed,
  };
}


function runCommand(
  command: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: process.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code: number | null) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.on("error", (error: Error) => {
      resolve({ exitCode: 1, stdout, stderr: error.message });
    });
  });
}


async function probeCommand(command: string, args: string[]): Promise<boolean> {
  const result = await runCommand(command, args);
  return result.exitCode === 0;
}
