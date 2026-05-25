import { chatMessageSchema, type ChatMessage } from "@chatting-cursor/shared";


export const CHAT_STATE_KEY = "chatState";


export interface PersistedChatState {
  messages: ChatMessage[];
  sessionId: string | null;
  selectedModel: string;
}


/** 从 localStorage 读取已保存的聊天状态 */
export function loadChatState(): PersistedChatState | null {
  try {
    const raw = localStorage.getItem(CHAT_STATE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as {
      messages?: unknown;
      sessionId?: unknown;
      selectedModel?: unknown;
    };
    if (!Array.isArray(parsed.messages)) {
      return null;
    }
    const messages: ChatMessage[] = [];
    for (const item of parsed.messages) {
      const result = chatMessageSchema.safeParse(item);
      if (result.success) {
        messages.push(result.data);
      }
    }
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : null;
    const selectedModel = typeof parsed.selectedModel === "string" ? parsed.selectedModel : "";
    if (messages.length === 0 && !sessionId && !selectedModel) {
      return null;
    }
    return { messages, sessionId, selectedModel };
  } catch {
    return null;
  }
}


/** 将聊天状态写入 localStorage */
export function saveChatState(state: PersistedChatState): void {
  localStorage.setItem(CHAT_STATE_KEY, JSON.stringify(state));
}


/** 清除已保存的聊天状态（新对话） */
export function clearChatState(): void {
  localStorage.removeItem(CHAT_STATE_KEY);
}
