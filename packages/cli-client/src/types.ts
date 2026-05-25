import type { RunEvent } from "@chatting-cursor/shared";

/** Cursor CLI 调用选项 */
export interface CursorCliRunOptions {
  prompt: string;
  runId: string;
  model?: string;
  workspace?: string;
  /** 可执行命令，默认自动探测 cursor-agent 或 cursor agent */
  command?: string;
  /** 命令参数前缀，默认 agent 子命令模式 */
  argsPrefix?: string[];
  timeoutMs?: number;
  onEvent?: (event: RunEvent) => void;
}


/** Cursor CLI 运行结果 */
export interface CursorCliRunResult {
  runId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}
