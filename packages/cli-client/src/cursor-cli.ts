import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { RunEvent } from "@chatting-cursor/shared";
import type { CursorCliRunOptions, CursorCliRunResult } from "./types.js";


const DEFAULT_TIMEOUT_MS = 600_000;


/** 是否强制或允许通过 WSL 调用 Agent CLI */
function shouldTryWslCli(): boolean {
  const mode = (process.env.CURSOR_CLI_MODE ?? "").trim().toLowerCase();
  if (mode === "wsl") {
    return true;
  }
  if (mode === "native" || mode === "windows") {
    return false;
  }
  return process.platform === "win32";
}


/** 将 Windows 路径转为 WSL 路径（供 --workspace / 图片路径 使用） */
export function formatPathForCli(filePath: string, viaWsl: boolean): string {
  if (!viaWsl || process.platform !== "win32") {
    return filePath;
  }
  return windowsPathToWsl(filePath);
}


/** 将 Windows 路径转为 WSL 路径（供 --workspace 使用） */
function windowsPathToWsl(workspace: string): string {
  const normalized = workspace.replace(/\\/g, "/");
  const match = /^([a-zA-Z]):\/(.*)$/.exec(normalized);
  if (!match) {
    return normalized;
  }
  const drive = match[1].toLowerCase();
  const rest = match[2] ?? "";
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}


/** 创建带 ISO 时间戳的运行事件 */
function makeEvent(
  runId: string,
  type: RunEvent["type"],
  partial: Pick<RunEvent, "text" | "data"> = {},
): RunEvent {
  return {
    runId,
    type,
    timestamp: new Date().toISOString(),
    ...partial,
  };
}


/** 从 assistant NDJSON 载荷提取文本（支持增量与完整两种模式） */
function extractAssistantText(payload: Record<string, unknown>): string {
  const message = payload.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const fromBlocks = message?.content
    ?.filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("") ?? "";
  if (fromBlocks) {
    return fromBlocks;
  }
  if (typeof payload.text === "string") {
    return payload.text;
  }
  const delta = payload.delta as { text?: string } | undefined;
  if (typeof delta?.text === "string") {
    return delta.text;
  }
  return "";
}


/** 判断 --stream-partial-output 下是否应采纳该 assistant 事件（避免重复缓冲） */
function shouldEmitAssistantPayload(payload: Record<string, unknown>): boolean {
  const hasPartialMarkers = "timestamp_ms" in payload || "model_call_id" in payload;
  if (!hasPartialMarkers) {
    return true;
  }
  if (payload.model_call_id != null && payload.model_call_id !== "") {
    return false;
  }
  if (!("timestamp_ms" in payload)) {
    return false;
  }
  return true;
}


/** 解析 stream-json 单行 NDJSON；成功解析为结构化事件时返回 true */
function parseStreamJsonLine(runId: string, line: string, onEvent?: (event: RunEvent) => void): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (!trimmed.startsWith("{")) {
    return false;
  }
  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    const eventType = typeof payload.type === "string" ? payload.type : "unknown";
    if (eventType === "assistant") {
      if (!shouldEmitAssistantPayload(payload)) {
        return true;
      }
      const text = extractAssistantText(payload);
      if (text) {
        onEvent?.(makeEvent(runId, "assistant", { text, data: payload }));
      }
      return true;
    }
    if (eventType === "thinking") {
      const thinkingText = typeof payload.text === "string" ? payload.text : "";
      onEvent?.(makeEvent(runId, "thinking", { text: thinkingText, data: payload }));
      return true;
    }
    if (eventType === "result") {
      const resultText = typeof payload.result === "string" ? payload.result : undefined;
      onEvent?.(makeEvent(runId, "result", { text: resultText, data: payload }));
      return true;
    }
    if (eventType === "tool_call" || eventType === "tool_call_started" || eventType === "tool_call_completed") {
      onEvent?.(makeEvent(runId, "tool_call", { data: payload }));
      return true;
    }
    onEvent?.(makeEvent(runId, "stdout", { data: payload }));
    return true;
  } catch {
    return false;
  }
}


/** 检查命令是否存在于 PATH */
async function commandExists(command: string): Promise<boolean> {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    try {
      await access(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathEnv = process.env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
      try {
        await access(candidate, constants.F_OK);
        return true;
      } catch {
        // 继续探测下一个候选
      }
    }
  }
  return false;
}


/** 验证命令是否支持 Agent CLI（stream-json / --print） */
async function verifyAgentCliSupport(command: string, argsPrefix: string[]): Promise<{ supported: boolean; helpOutput: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...argsPrefix, "--help"], {
      env: process.env,
      shell: process.platform === "win32" && command !== "wsl",
    });
    let output = "";
    const append = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", () => resolve({ supported: false, helpOutput: output }));
    child.on("close", () => {
      resolve({ supported: output.includes("stream-json"), helpOutput: output });
    });
  });
}


/** 判断 help 输出是否来自 IDE 启动器（cursor.cmd），而非 Agent CLI */
function looksLikeIdeLauncher(helpOutput: string): boolean {
  return helpOutput.includes("Usage: cursor.exe") || helpOutput.includes("Open a file at the path");
}


/** 构建 Agent CLI 缺失时的错误提示 */
function buildMissingAgentCliMessage(hasIdeLauncher: boolean): string {
  const lines = [
    "No usable Cursor Agent CLI (cursor-agent) was detected.",
  ];
  if (hasIdeLauncher) {
    lines.push(
      "The `cursor` command in PATH is the IDE launcher (`cursor.cmd`), not the terminal Agent CLI.",
      "Running `cursor agent --print` only opens the IDE and does not return an Agent response.",
    );
  }
  if (process.platform === "win32") {
    lines.push(
      "The official installer is Linux/macOS only; on Windows install via WSL or use a community Windows port.",
      "WSL install: `wsl --install` then `curl https://cursor.com/install -fsS | bash`",
      "Verify: `cursor-agent --version` (help output should include `stream-json`)",
      "Login: `cursor-agent login`",
    );
  } else {
    lines.push(
      "Install: `curl https://cursor.com/install -fsS | bash`",
      "Verify: `cursor-agent --version`",
      "Login: `cursor-agent login`",
    );
  }
  return lines.join(" ");
}


const WSL_CURSOR_AGENT_PATH_SCRIPT = 'export PATH="$HOME/.local/bin:$PATH"; command -v cursor-agent';


/** 在 WSL 中执行命令并捕获 stdout/stderr */
function runWslCapture(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("wsl", args, {
      env: process.env,
      shell: false,
    });
    let output = "";
    const append = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(output.trim()));
  });
}


/** 解析 WSL 内 cursor-agent 可执行文件绝对路径 */
async function resolveWslCursorAgentExecutable(): Promise<string | null> {
  const pathOutput = await runWslCapture(["bash", "-lc", WSL_CURSOR_AGENT_PATH_SCRIPT]);
  const lines = pathOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const executable = lines[lines.length - 1] ?? "";
  if (!executable.startsWith("/")) {
    return null;
  }
  return executable;
}


/** 通过 WSL 解析 cursor-agent 命令 */
async function resolveWslCommand(): Promise<{ command: string; argsPrefix: string[] } | null> {
  if (!shouldTryWslCli()) {
    return null;
  }
  const executable = await resolveWslCursorAgentExecutable();
  if (!executable) {
    return null;
  }
  const wslCandidate = { command: "wsl", argsPrefix: ["-e", executable] };
  const verification = await verifyAgentCliSupport(wslCandidate.command, wslCandidate.argsPrefix);
  if (verification.supported) {
    return wslCandidate;
  }
  return null;
}


/** 解析本机（非 WSL）Cursor CLI 命令 */
async function resolveNativeCommand(): Promise<{ command: string; argsPrefix: string[]; hasIdeLauncher: boolean } | null> {
  const candidates: Array<{ command: string; argsPrefix: string[] }> = [
    { command: "cursor-agent", argsPrefix: [] },
    { command: "cursor", argsPrefix: ["agent"] },
  ];
  let hasIdeLauncher = false;
  for (const candidate of candidates) {
    if (!(await commandExists(candidate.command))) {
      continue;
    }
    const verification = await verifyAgentCliSupport(candidate.command, candidate.argsPrefix);
    if (verification.supported) {
      return { ...candidate, hasIdeLauncher };
    }
    if (candidate.command === "cursor" && looksLikeIdeLauncher(verification.helpOutput)) {
      hasIdeLauncher = true;
    }
  }
  return hasIdeLauncher ? { command: "", argsPrefix: [], hasIdeLauncher: true } : null;
}


/** 解析默认 Cursor CLI 命令 */
async function resolveDefaultCommand(): Promise<{ command: string; argsPrefix: string[] }> {
  const mode = (process.env.CURSOR_CLI_MODE ?? "").trim().toLowerCase();
  if (mode !== "wsl") {
    const native = await resolveNativeCommand();
    if (native && native.command) {
      return { command: native.command, argsPrefix: native.argsPrefix };
    }
  }
  const wsl = await resolveWslCommand();
  if (wsl) {
    return wsl;
  }
  const nativeFallback = await resolveNativeCommand();
  const hasIdeLauncher = Boolean(nativeFallback?.hasIdeLauncher);
  throw new Error(buildMissingAgentCliMessage(hasIdeLauncher));
}


/** 构建 CLI 参数列表 */
function buildArgs(options: CursorCliRunOptions, argsPrefix: string[], viaWsl: boolean): string[] {
  const args = [...argsPrefix, "--print", "--output-format", "stream-json", "--stream-partial-output", "--force"];
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.workspace) {
    const workspace = formatPathForCli(options.workspace, viaWsl);
    args.push("--workspace", workspace);
  }
  args.push(options.prompt);
  return args;
}


/** 按行切分缓冲区并解析 NDJSON */
function drainLineBuffer(
  runId: string,
  buffer: string,
  onEvent: ((event: RunEvent) => void) | undefined,
  mode: "stream-json" | "plain",
  onPlainLine?: (line: string) => void,
): string {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    if (mode === "stream-json") {
      const parsed = parseStreamJsonLine(runId, line, onEvent);
      if (!parsed && onPlainLine) {
        onPlainLine(line);
      }
      continue;
    }
    onEvent?.(makeEvent(runId, "stdout", { text: line }));
  }
  return remainder;
}


/** 向缓冲区追加并按行分发；close 前须调用 flush 以免丢失末行 result */
function createLineHandler(
  runId: string,
  onEvent: ((event: RunEvent) => void) | undefined,
  mode: "stream-json" | "plain",
): { handleChunk: (chunk: Buffer, channel: "stdout" | "stderr") => void; flush: () => void } {
  let stdoutBuffer = "";
  let stderrBuffer = "";
  const flushChannel = (
    buffer: string,
    emitPlain: (line: string) => void,
  ): void => {
    if (!buffer.trim()) {
      return;
    }
    if (mode === "stream-json") {
      const parsed = parseStreamJsonLine(runId, buffer, onEvent);
      if (!parsed) {
        emitPlain(buffer);
      }
      return;
    }
    emitPlain(buffer);
  };
  return {
    handleChunk(chunk: Buffer, channel: "stdout" | "stderr") {
      const text = chunk.toString("utf8");
      if (channel === "stderr") {
        if (mode !== "stream-json") {
          onEvent?.(makeEvent(runId, "stderr", { text }));
          return;
        }
        stderrBuffer += text;
        stderrBuffer = drainLineBuffer(runId, stderrBuffer, onEvent, mode, (line) => {
          onEvent?.(makeEvent(runId, "stderr", { text: `${line}\n` }));
        });
        return;
      }
      onEvent?.(makeEvent(runId, "raw_stdout", { text }));
      stdoutBuffer += text;
      stdoutBuffer = drainLineBuffer(runId, stdoutBuffer, onEvent, mode);
    },
    flush() {
      stdoutBuffer = drainLineBuffer(runId, stdoutBuffer, onEvent, mode);
      flushChannel(stdoutBuffer, () => undefined);
      stdoutBuffer = "";
      stderrBuffer = drainLineBuffer(runId, stderrBuffer, onEvent, mode, (line) => {
        onEvent?.(makeEvent(runId, "stderr", { text: line }));
      });
      flushChannel(stderrBuffer, (line) => {
        onEvent?.(makeEvent(runId, "stderr", { text: line }));
      });
      stderrBuffer = "";
    },
  };
}


/** 运行 Cursor CLI 并流式输出事件 */
export async function runCursorCli(options: CursorCliRunOptions): Promise<CursorCliRunResult> {
  const resolved = options.command
    ? { command: options.command, argsPrefix: options.argsPrefix ?? [] }
    : await resolveDefaultCommand();
  const viaWsl = resolved.command === "wsl";
  const args = buildArgs(options, resolved.argsPrefix, viaWsl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  options.onEvent?.(makeEvent(options.runId, "run_started", {
    data: {
      command: resolved.command,
      args: args.slice(0, -1),
      prompt: options.prompt,
    },
  }));
  return new Promise((resolve) => {
    const child: ChildProcessWithoutNullStreams = spawn(resolved.command, args, {
      cwd: options.workspace,
      env: process.env,
      shell: process.platform === "win32" && resolved.command !== "wsl",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      options.onEvent?.(makeEvent(options.runId, "error", {
        text: `CLI run timed out (${timeoutMs}ms)`,
      }));
    }, timeoutMs);
    const lineHandler = createLineHandler(options.runId, options.onEvent, "stream-json");
    child.stdout.on("data", (chunk: Buffer) => lineHandler.handleChunk(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => lineHandler.handleChunk(chunk, "stderr"));
    child.on("error", (error) => {
      clearTimeout(timer);
      lineHandler.flush();
      options.onEvent?.(makeEvent(options.runId, "error", { text: error.message }));
      options.onEvent?.(makeEvent(options.runId, "run_finished", {
        data: { exitCode: null, timedOut: false },
      }));
      resolve({ runId: options.runId, exitCode: null, signal: null, timedOut: false });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      lineHandler.flush();
      options.onEvent?.(makeEvent(options.runId, "run_finished", {
        data: { exitCode, signal, timedOut },
      }));
      resolve({ runId: options.runId, exitCode, signal, timedOut });
    });
  });
}


/** 合并流式 assistant 文本，避免重复累积 */
export function mergeAssistantStreamText(current: string, incoming: string): string {
  if (!incoming) {
    return current;
  }
  if (incoming === current) {
    return current;
  }
  if (incoming.startsWith(current)) {
    return incoming;
  }
  if (current.endsWith(incoming)) {
    return current;
  }
  return current + incoming;
}


/** 解析 cursor-agent models 命令输出 */
function parseModelsOutput(output: string): Array<{ id: string; label: string; isDefault?: boolean }> {
  const models: Array<{ id: string; label: string; isDefault?: boolean }> = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Available models") || trimmed.startsWith("Tip:")) {
      continue;
    }
    const match = /^(\S+)\s+-\s+(.+)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const id = match[1];
    let label = match[2].trim();
    const isDefault = label.includes("(current, default)");
    label = label.replace(/\s*\(current, default\)\s*$/, "").trim();
    models.push({ id, label, isDefault: isDefault || undefined });
  }
  return models;
}


/** 常见模型列表（CLI 不可用时回退） */
export const FALLBACK_MODELS: Array<{ id: string; label: string; isDefault?: boolean }> = [
  { id: "composer-2.5-fast", label: "Composer 2.5 Fast", isDefault: true },
  { id: "composer-2.5", label: "Composer 2.5" },
  { id: "gpt-5.4-medium", label: "GPT-5.4 1M" },
  { id: "gpt-5.5-medium", label: "GPT-5.5 1M" },
  { id: "claude-opus-4-7-medium", label: "Opus 4.7 1M Medium" },
  { id: "claude-4.6-sonnet-medium", label: "Sonnet 4.6 1M" },
  { id: "auto", label: "Auto" },
];


/** 列出 cursor-agent 可用模型 */
export async function listCursorModels(): Promise<{
  models: Array<{ id: string; label: string; isDefault?: boolean }>;
  source: "cli" | "fallback";
}> {
  try {
    const resolved = await resolveDefaultCommand();
    const output = await new Promise<string>((resolve) => {
      const child = spawn(resolved.command, [...resolved.argsPrefix, "models"], {
        env: process.env,
        shell: process.platform === "win32" && resolved.command !== "wsl",
      });
      let text = "";
      const append = (chunk: Buffer): void => {
        text += chunk.toString("utf8");
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", () => resolve(""));
      child.on("close", () => resolve(text));
    });
    const models = parseModelsOutput(output);
    if (models.length > 0) {
      return { models, source: "cli" };
    }
  } catch {
    // CLI 不可用时使用回退列表
  }
  return { models: FALLBACK_MODELS, source: "fallback" };
}


/** 探测 Cursor CLI 是否可用 */
export async function probeCursorCli(): Promise<{ available: boolean; command?: string; message?: string }> {
  try {
    const resolved = await resolveDefaultCommand();
    const label = resolved.command === "wsl" ? "wsl cursor-agent" : resolved.command;
    return { available: true, command: label };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { available: false, message };
  }
}
