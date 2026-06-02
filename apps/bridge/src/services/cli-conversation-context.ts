import {
  buildOfflineSystemContent,
  formatCliConversationLines,
  isPromptDuplicatedInRecentHistory,
  selectRecentHistory,
} from "./conversation-context.js";
import type { SessionMessage } from "./session-store.js";


const DEFAULT_CLI_SYSTEM_PROMPT =
  "You are a helpful assistant for ChattingCursor via Cursor Agent CLI. Answer clearly and helpfully.";


/** 为 cursor-agent CLI 组装完整用户提示（含 system、知识库、近 20 轮历史） */
export async function buildCliPromptFromSession(options: {
  prompt: string;
  history: SessionMessage[];
  defaultPrompt?: string;
}): Promise<string> {
  const system = await buildOfflineSystemContent({
    defaultPrompt: options.defaultPrompt ?? DEFAULT_CLI_SYSTEM_PROMPT,
  });
  const recent = selectRecentHistory(options.history);
  const historyBlock = formatCliConversationLines(recent);
  const promptTrimmed = options.prompt.trim();
  const skipCurrentUser = isPromptDuplicatedInRecentHistory(options.history, options.prompt);
  const parts: string[] = ["【系统说明】", system];
  if (historyBlock) {
    parts.push("", "【对话历史】", historyBlock);
  }
  if (promptTrimmed && !skipCurrentUser) {
    parts.push("", "【当前用户消息】", promptTrimmed);
  }
  return parts.join("\n");
}
