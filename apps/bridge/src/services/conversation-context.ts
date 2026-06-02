import { buildKnowledgeContext } from "./knowledge-store.js";
import type { SessionMessage } from "./session-store.js";


/** 与离线模型、CLI 共用的近期对话条数上限 */
export const RECENT_HISTORY_LIMIT = 20;


const DEFAULT_OFFLINE_SYSTEM_PROMPT =
  "You are a helpful assistant running locally for ChattingCursor. Answer clearly and helpfully.";


/** 取最近 N 条有效 user/assistant 消息（过滤空内容） */
export function selectRecentHistory(
  history: SessionMessage[],
  limit = RECENT_HISTORY_LIMIT,
): SessionMessage[] {
  const recent = history.slice(-limit);
  return recent.filter((item) => {
    if (item.role !== "user" && item.role !== "assistant") {
      return false;
    }
    return item.content.trim().length > 0;
  });
}


/** 离线/CLI 共用的 system 正文：默认提示词 + 本地知识库 */
export async function buildOfflineSystemContent(options?: {
  defaultPrompt?: string;
  maxKnowledgeChars?: number;
}): Promise<string> {
  const knowledge = await buildKnowledgeContext(options?.maxKnowledgeChars);
  const systemParts = [
    options?.defaultPrompt?.trim() || DEFAULT_OFFLINE_SYSTEM_PROMPT,
    knowledge ? `\n${knowledge}` : "",
  ].filter(Boolean);
  return systemParts.join("\n");
}


/** 将对话格式化为 CLI 提示词中的「用户/助手」行 */
export function formatCliConversationLines(messages: SessionMessage[]): string {
  if (messages.length === 0) {
    return "";
  }
  return messages.map((message) => {
    const roleLabel = message.role === "user" ? "用户" : "助手";
    const text = message.content.trim() || "（无文字，可能为图片消息）";
    return `${roleLabel}: ${text}`;
  }).join("\n");
}


/** 当前轮用户消息是否已出现在近期历史末尾（避免重复拼接） */
export function isPromptDuplicatedInRecentHistory(
  history: SessionMessage[],
  prompt: string,
): boolean {
  const recent = selectRecentHistory(history);
  const last = recent[recent.length - 1];
  return last?.role === "user" && last.content.trim() === prompt.trim();
}
