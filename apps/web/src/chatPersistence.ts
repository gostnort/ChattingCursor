import { chatMessageSchema, isOfflineModelId, type ChatMessage } from "@chatting-cursor/shared";


export const CHAT_STATE_KEY = "chatState";
export const OFFLINE_CHAT_CONTEXTS_KEY = "offlineChatContexts";
export const MODEL_STORAGE_KEY = "selectedModel";


export interface PersistedChatState {
  messages: ChatMessage[];
  sessionId: string | null;
  selectedModel: string;
}


export interface OfflineModelChatSnapshot {
  messages: ChatMessage[];
  sessionId: string | null;
}


/** 离线模型快照在 offlineChatContexts 中的键：完整 model id，如 local-llm/unsloth/gemma-4-E4B-it-GGUF */
export function offlineModelContextKey(modelId: string): string {
  return modelId;
}


function parseChatMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const messages: ChatMessage[] = [];
  for (const item of raw) {
    const result = chatMessageSchema.safeParse(item);
    if (result.success) {
      messages.push(result.data);
    }
  }
  return messages;
}


function parseOfflineSnapshot(raw: unknown): OfflineModelChatSnapshot | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const entry = raw as { messages?: unknown; sessionId?: unknown };
  const messages = parseChatMessages(entry.messages);
  const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : null;
  if (messages.length === 0 && !sessionId) {
    return null;
  }
  return { messages, sessionId };
}


/** 从 localStorage 读取已保存的聊天状态（在线 / Auto 会话） */
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
    const messages = parseChatMessages(parsed.messages);
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


/** 将在线聊天状态写入 localStorage */
export function loadOfflineChatContexts(): Record<string, OfflineModelChatSnapshot> {
  try {
    const raw = localStorage.getItem(OFFLINE_CHAT_CONTEXTS_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, OfflineModelChatSnapshot> = {};
    for (const [modelId, value] of Object.entries(parsed)) {
      const snapshot = parseOfflineSnapshot(value);
      if (snapshot) {
        result[modelId] = snapshot;
      }
    }
    return result;
  } catch {
    return {};
  }
}


/** 读取单个离线模型的上次会话快照 */
export function loadOfflineModelContext(modelId: string): OfflineModelChatSnapshot | null {
  return loadOfflineChatContexts()[modelId] ?? null;
}


/** 保存单个离线模型的会话快照 */
export function saveOfflineModelContext(modelId: string, snapshot: OfflineModelChatSnapshot): void {
  const contexts = loadOfflineChatContexts();
  if (snapshot.messages.length === 0 && !snapshot.sessionId) {
    delete contexts[modelId];
  } else {
    contexts[modelId] = snapshot;
  }
  if (Object.keys(contexts).length === 0) {
    localStorage.removeItem(OFFLINE_CHAT_CONTEXTS_KEY);
    return;
  }
  localStorage.setItem(OFFLINE_CHAT_CONTEXTS_KEY, JSON.stringify(contexts));
}


/** 清除单个离线模型的已保存会话 */
export function clearOfflineModelContext(modelId: string): void {
  saveOfflineModelContext(modelId, { messages: [], sessionId: null });
}


/** 将聊天状态写入 localStorage（在线 / Auto） */
export function saveChatState(state: PersistedChatState): void {
  localStorage.setItem(CHAT_STATE_KEY, JSON.stringify(state));
}


/** 清除已保存的在线聊天状态（新对话） */
export function clearChatState(): void {
  localStorage.removeItem(CHAT_STATE_KEY);
}


/** 启动时：若 chatState 绑定离线模型，迁移到 offlineChatContexts 并返回在线初始 UI 状态 */
export function resolveInitialChatState(): {
  messages: ChatMessage[];
  sessionId: string | null;
  selectedModel: string;
} {
  const restored = loadChatState();
  const storedModel = restored?.selectedModel ?? localStorage.getItem(MODEL_STORAGE_KEY) ?? "";
  if (isOfflineModelId(storedModel) && restored) {
    saveOfflineModelContext(storedModel, {
      messages: restored.messages,
      sessionId: restored.sessionId,
    });
    saveChatState({ messages: [], sessionId: null, selectedModel: "" });
    return { messages: [], sessionId: null, selectedModel: "" };
  }
  return {
    messages: restored?.messages ?? [],
    sessionId: restored?.sessionId ?? null,
    selectedModel: isOfflineModelId(storedModel) ? "" : storedModel,
  };
}


/** 读取可恢复的在线会话快照（不含离线模型） */
export function loadOnlineChatSnapshot(): OfflineModelChatSnapshot | null {
  const state = loadChatState();
  if (!state || isOfflineModelId(state.selectedModel)) {
    return null;
  }
  if (state.messages.length === 0 && !state.sessionId) {
    return null;
  }
  return { messages: state.messages, sessionId: state.sessionId };
}
