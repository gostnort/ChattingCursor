import type {
  AuthStatusResponse,
  AuthVerifyResponse,
  ChatNewSessionResponse,
  ChatSendResponse,
  CrewStatusResponse,
  HistorySearchResponse,
  LatestRunResponse,
  LocalConfigResponse,
  LocalHistoryContentResponse,
  LocalHistoryListResponse,
  LocalTokenDirectoryUpdateResponse,
  LocalTokenFileResponse,
  ModelsResponse,
  RecentChatSessionResponse,
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
  publicBridgeUrl?: string;
  timestamp: string;
}


function buildAuthHeaders(token?: string, extra: Record<string, string> = {}): HeadersInit {
  const headers: Record<string, string> = { ...extra };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}


async function readErrorDetail(response: Response, fallback: string): Promise<string> {
  const body = await response.text();
  let detail = body || fallback;
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) {
      detail = parsed.message;
    }
  } catch {
    // 非 JSON 响应，保留原始文本
  }
  return detail;
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
export async function createChatSession(bridgeUrl: string, token?: string): Promise<ChatNewSessionResponse> {
  const response = await fetch(`${bridgeUrl}/chat/new-session`, {
    method: "POST",
    headers: buildAuthHeaders(token, { "Content-Type": "application/json" }),
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `新建会话失败 (${response.status})`));
  }
  return response.json() as Promise<ChatNewSessionResponse>;
}


/** 获取可用模型列表 */
export async function fetchModels(bridgeUrl: string, token?: string): Promise<ModelsResponse> {
  const response = await fetch(`${bridgeUrl}/models`, {
    headers: buildAuthHeaders(token),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `获取模型列表失败 (${response.status})`));
  }
  return response.json() as Promise<ModelsResponse>;
}


/** 搜索本地历史 */
export async function searchHistory(bridgeUrl: string, query: string, token?: string): Promise<HistorySearchResponse> {
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`${bridgeUrl}/history/search?${params.toString()}`, {
    headers: buildAuthHeaders(token),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `搜索历史失败 (${response.status})`));
  }
  return response.json() as Promise<HistorySearchResponse>;
}


/** 获取最近一次活跃会话，用于跨设备恢复 */
export async function fetchRecentChatSession(bridgeUrl: string, token?: string): Promise<RecentChatSessionResponse | null> {
  const response = await fetch(`${bridgeUrl}/chat/recent-session`, {
    headers: buildAuthHeaders(token),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `获取最近会话失败 (${response.status})`));
  }
  return response.json() as Promise<RecentChatSessionResponse>;
}


/** 获取最近一次运行的 runId */
export async function fetchLatestRun(bridgeUrl: string, token?: string): Promise<LatestRunResponse | null> {
  const response = await fetch(`${bridgeUrl}/chat/latest-run`, {
    headers: buildAuthHeaders(token),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `获取最新运行失败 (${response.status})`));
  }
  return response.json() as Promise<LatestRunResponse>;
}


/** 发送聊天消息并返回 runId */
export async function sendChatMessage(
  bridgeUrl: string,
  prompt: string,
  options: { model?: string; modelLabel?: string; sessionId?: string; token?: string } = {},
): Promise<ChatSendResponse> {
  const response = await fetch(`${bridgeUrl}/chat/send`, {
    method: "POST",
    headers: buildAuthHeaders(options.token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      prompt,
      model: options.model,
      modelLabel: options.modelLabel,
      sessionId: options.sessionId,
    }),
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response, `发送失败 (${response.status})`);
    throw new Error(`发送失败 (${response.status}): ${detail}`);
  }
  return response.json() as Promise<ChatSendResponse>;
}


function parseSsePayload(buffer: string, onEvent: (event: RunEvent) => void): string {
  const chunks = buffer.split("\n\n");
  const tail = chunks.pop() ?? "";
  for (const chunk of chunks) {
    const dataLines = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length));
    if (dataLines.length === 0) {
      continue;
    }
    try {
      const event = JSON.parse(dataLines.join("\n")) as RunEvent;
      onEvent(event);
    } catch {
      // 忽略单条坏数据，继续消费后续流
    }
  }
  return tail;
}


function streamRunEvents(
  url: string,
  token: string | undefined,
  onEvent: (event: RunEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(url, {
        headers: buildAuthHeaders(token),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(await readErrorDetail(response, `流式请求失败 (${response.status})`));
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        buffer = parseSsePayload(buffer, onEvent);
      }
      if (buffer.trim()) {
        parseSsePayload(buffer + "\n\n", onEvent);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  })();
  return () => controller.abort();
}


/** 订阅 run 的流式事件 */
export function subscribeRunEvents(
  bridgeUrl: string,
  runId: string,
  onEvent: (event: RunEvent) => void,
  onError?: (error: Error) => void,
  token?: string,
): () => void {
  return streamRunEvents(`${bridgeUrl}/chat/stream/${runId}`, token, onEvent, onError);
}


/** 订阅 cursor-agent 原始终端输出（stdout/stderr） */
export function subscribeTerminalEvents(
  bridgeUrl: string,
  runId: string,
  onEvent: (event: RunEvent) => void,
  onError?: (error: Error) => void,
  token?: string,
): () => void {
  return streamRunEvents(`${bridgeUrl}/chat/terminal/${runId}`, token, onEvent, onError);
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


/** 判断 Bridge URL 是否指向本机 */
export function isLocalBridgeUrl(bridgeUrl: string): boolean {
  try {
    const url = new URL(bridgeUrl);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}


/** 获取本地配置（仅 localhost Bridge） */
export async function fetchLocalConfig(bridgeUrl: string, token?: string): Promise<LocalConfigResponse> {
  const response = await fetch(`${bridgeUrl}/local/config`, {
    headers: buildAuthHeaders(token),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `本地配置不可用 (${response.status})`));
  }
  return response.json() as Promise<LocalConfigResponse>;
}


/** 列出全部历史会话文件 */
export async function fetchHistoryList(bridgeUrl: string, token?: string): Promise<LocalHistoryListResponse> {
  const response = await fetch(`${bridgeUrl}/local/history`, {
    headers: buildAuthHeaders(token),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `历史列表不可用 (${response.status})`));
  }
  return response.json() as Promise<LocalHistoryListResponse>;
}


/** 读取单个历史文件内容 */
export async function fetchHistoryContent(
  bridgeUrl: string,
  file: string,
  token?: string,
): Promise<LocalHistoryContentResponse> {
  const response = await fetch(`${bridgeUrl}/local/history/${encodeURIComponent(file)}`, {
    headers: buildAuthHeaders(token),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `读取历史失败 (${response.status})`));
  }
  return response.json() as Promise<LocalHistoryContentResponse>;
}


/** 读取当天 token 文件内容（仅本机） */
export async function fetchLocalTokenFile(bridgeUrl: string, token?: string): Promise<LocalTokenFileResponse> {
  const response = await fetch(`${bridgeUrl}/local/token-file`, {
    headers: buildAuthHeaders(token),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `读取 token 文件失败 (${response.status})`));
  }
  return response.json() as Promise<LocalTokenFileResponse>;
}


/** 更新本机 token 同步目录 */
export async function updateTokenDirectory(
  bridgeUrl: string,
  directory: string,
  token?: string,
): Promise<LocalTokenDirectoryUpdateResponse> {
  const response = await fetch(`${bridgeUrl}/local/token-directory`, {
    method: "POST",
    headers: buildAuthHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ directory }),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `更新 token 目录失败 (${response.status})`));
  }
  return response.json() as Promise<LocalTokenDirectoryUpdateResponse>;
}


/** 获取 crewAI 环境状态 */
export async function fetchCrewStatus(bridgeUrl: string, token?: string): Promise<CrewStatusResponse> {
  const response = await fetch(`${bridgeUrl}/crews/status`, {
    headers: buildAuthHeaders(token),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `crewAI 状态不可用 (${response.status})`));
  }
  return response.json() as Promise<CrewStatusResponse>;
}


/** 获取当前认证状态 */
export async function fetchAuthStatus(bridgeUrl: string): Promise<AuthStatusResponse> {
  const response = await fetch(`${bridgeUrl}/auth/status`);
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `认证状态不可用 (${response.status})`));
  }
  return response.json() as Promise<AuthStatusResponse>;
}


/** 验证当前口令是否有效 */
export async function verifyBridgeToken(bridgeUrl: string, token: string): Promise<AuthVerifyResponse> {
  const response = await fetch(`${bridgeUrl}/auth/verify`, {
    method: "POST",
    headers: buildAuthHeaders(token, { "Content-Type": "application/json" }),
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `口令验证失败 (${response.status})`));
  }
  return response.json() as Promise<AuthVerifyResponse>;
}
