import type {
  ChatNewSessionResponse,
  ChatSendResponse,
  HistorySearchResponse,
  ModelsResponse,
  RunEvent,
} from "@chatting-cursor/shared";


/** Bridge /health 响应 */
export interface BridgeHealthResponse {
  status: string;
  cli: {
    available: boolean;
    command?: string;
    message?: string;
  };
  timestamp: string;
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


/** 创建新会话 */
export async function createChatSession(bridgeUrl: string): Promise<ChatNewSessionResponse> {
  const response = await fetch(`${bridgeUrl}/chat/new-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`新建会话失败 (${response.status})`);
  }
  return response.json() as Promise<ChatNewSessionResponse>;
}


/** 获取可用模型列表 */
export async function fetchModels(bridgeUrl: string): Promise<ModelsResponse> {
  const response = await fetch(`${bridgeUrl}/models`);
  if (!response.ok) {
    throw new Error(`获取模型列表失败 (${response.status})`);
  }
  return response.json() as Promise<ModelsResponse>;
}


/** 搜索本地历史 */
export async function searchHistory(bridgeUrl: string, query: string): Promise<HistorySearchResponse> {
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`${bridgeUrl}/history/search?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`搜索历史失败 (${response.status})`);
  }
  return response.json() as Promise<HistorySearchResponse>;
}


/** 发送聊天消息并返回 runId */
export async function sendChatMessage(
  bridgeUrl: string,
  prompt: string,
  options: { model?: string; sessionId?: string } = {},
): Promise<ChatSendResponse> {
  const response = await fetch(`${bridgeUrl}/chat/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      model: options.model,
      sessionId: options.sessionId,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) {
        detail = parsed.message;
      }
    } catch {
      // 非 JSON 响应，保留原始文本
    }
    throw new Error(`发送失败 (${response.status}): ${detail}`);
  }
  return response.json() as Promise<ChatSendResponse>;
}


/** 订阅 run 的 SSE 事件流 */
export function subscribeRunEvents(
  bridgeUrl: string,
  runId: string,
  onEvent: (event: RunEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  const source = new EventSource(`${bridgeUrl}/chat/stream/${runId}`);
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as RunEvent;
      onEvent(event);
      if (event.type === "run_finished") {
        source.close();
      }
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };
  source.onerror = () => {
    onError?.(new Error("SSE 连接中断"));
    source.close();
  };
  return () => source.close();
}


/** 订阅 cursor-agent 原始终端输出（stdout/stderr） */
export function subscribeTerminalEvents(
  bridgeUrl: string,
  runId: string,
  onEvent: (event: RunEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  const source = new EventSource(`${bridgeUrl}/chat/terminal/${runId}`);
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as RunEvent;
      onEvent(event);
      if (event.type === "run_finished") {
        source.close();
      }
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };
  source.onerror = () => {
    onError?.(new Error("终端 SSE 连接中断"));
    source.close();
  };
  return () => source.close();
}


/** 获取 Bridge 健康状态 */
export async function fetchBridgeHealth(bridgeUrl: string): Promise<BridgeHealthResponse | null> {
  try {
    const response = await fetch(`${bridgeUrl}/health`);
    if (!response.ok) {
      return null;
    }
    return response.json() as Promise<BridgeHealthResponse>;
  } catch {
    return null;
  }
}
