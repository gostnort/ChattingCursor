import type {
  AuthStatusResponse,
  AuthVerifyResponse,
  ChatNewSessionResponse,
  ChatSendResponse,
  ChatImageUploadResponse,
  ChatAnalyzeImageResponse,
  HistorySearchResponse,
  LatestRunResponse,
  LocalConfigResponse,
  LocalHistoryContentResponse,
  LocalHistoryListResponse,
  LocalTokenDirectoryUpdateResponse,
  LocalCloudflareTunnelResponse,
  CloudflareTunnelConfig,
  LocalTokenFileResponse,
  ModelsResponse,
  RecentChatSessionResponse,
  RunEvent,
  KnowledgeTreeResponse,
  KnowledgeCreateNodeResponse,
  KnowledgeUploadContentResponse,
  KnowledgeRenameNodeResponse,
  OfflineWarmupResponse,
} from "@chatting-cursor/shared";


/** Bridge /health 响应 */
export interface BridgeHealthResponse {
  status: string;
  cli: {
    available: boolean;
    mode: "native" | "wsl" | "none";
    requestedMode?: string;
    command?: string;
    message?: string;
    fallbackFromNative?: boolean;
  };
  chrome?: {
    available: boolean;
    endpoint: string;
    pages?: number;
    message?: string;
  };
  webSearchAvailable?: boolean;
  publicBridgeUrl?: string;
  gemma4?: LocalConfigResponse["gemma4"];
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


/** 预热本地离线模型（选择模型后主动加载 sidecar） */
export async function warmupOfflineModel(
  bridgeUrl: string,
  modelId: string,
  token?: string,
): Promise<OfflineWarmupResponse> {
  const response = await fetch(`${bridgeUrl}/offline/warmup`, {
    method: "POST",
    headers: buildAuthHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ modelId }),
  });
  if (!response.ok) {
    const body = await response.text();
    let parsed: Partial<OfflineWarmupResponse & { message?: string }> = {};
    try {
      parsed = JSON.parse(body) as Partial<OfflineWarmupResponse & { message?: string }>;
    } catch {
      // 非 JSON 响应
    }
    const error = new Error(
      parsed.message ?? (body || `离线模型预热失败 (${response.status})`),
    ) as Error & { snapshot?: OfflineWarmupResponse };
    if (parsed.modelId) {
      error.snapshot = parsed as OfflineWarmupResponse;
    }
    throw error;
  }
  return response.json() as Promise<OfflineWarmupResponse>;
}


/** 查询本地离线模型是否已就绪（不拉起进程） */
export async function fetchOfflineModelStatus(
  bridgeUrl: string,
  modelId: string,
  token?: string,
): Promise<OfflineWarmupResponse> {
  const params = new URLSearchParams({ modelId });
  const response = await fetch(`${bridgeUrl}/offline/status?${params.toString()}`, {
    headers: buildAuthHeaders(token),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `离线模型状态不可用 (${response.status})`));
  }
  return response.json() as Promise<OfflineWarmupResponse>;
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


/** 上传聊天图片（jpeg/png） */
export async function uploadChatImage(
  bridgeUrl: string,
  file: File,
  sessionId: string | undefined,
  token?: string,
): Promise<ChatImageUploadResponse> {
  const form = new FormData();
  form.append("file", file);
  if (sessionId) {
    form.append("sessionId", sessionId);
  }
  const response = await fetch(`${bridgeUrl}/chat/upload-image`, {
    method: "POST",
    headers: buildAuthHeaders(token),
    body: form,
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `Image upload failed (${response.status})`));
  }
  return response.json() as Promise<ChatImageUploadResponse>;
}


/** 分析图片并转发到当前 agent-cli 会话 */
export async function analyzeChatImage(
  bridgeUrl: string,
  payload: {
    sessionId: string;
    imageId: string;
    fileName: string;
    model?: string;
    modelLabel?: string;
    userIntent?: string;
  },
  token?: string,
): Promise<ChatAnalyzeImageResponse> {
  const response = await fetch(`${bridgeUrl}/chat/analyze-image`, {
    method: "POST",
    headers: buildAuthHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `Image analysis failed (${response.status})`));
  }
  return response.json() as Promise<ChatAnalyzeImageResponse>;
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


/** 读取本机 Cloudflare 命名隧道配置 */
export async function fetchCloudflareTunnelConfig(
  bridgeUrl: string,
  token?: string,
): Promise<LocalCloudflareTunnelResponse> {
  const response = await fetch(`${bridgeUrl}/local/cloudflare-tunnel`, {
    headers: buildAuthHeaders(token),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `Cloudflare tunnel config unavailable (${response.status})`));
  }
  return response.json() as Promise<LocalCloudflareTunnelResponse>;
}


/** 保存本机 Cloudflare 命名隧道配置（写入 ~/.chattingcursor/cloudflare-tunnel.json） */
export async function saveCloudflareTunnelConfig(
  bridgeUrl: string,
  config: CloudflareTunnelConfig,
  token?: string,
): Promise<LocalCloudflareTunnelResponse> {
  const response = await fetch(`${bridgeUrl}/local/cloudflare-tunnel`, {
    method: "POST",
    headers: buildAuthHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `Failed to save Cloudflare tunnel config (${response.status})`));
  }
  return response.json() as Promise<LocalCloudflareTunnelResponse>;
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


/** 获取当前认证状态 */
export async function fetchAuthStatus(bridgeUrl: string): Promise<AuthStatusResponse> {
  const response = await fetch(`${bridgeUrl}/auth/status`);
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `认证状态不可用 (${response.status})`));
  }
  return response.json() as Promise<AuthStatusResponse>;
}


/** 获取知识库 wiki 树 */
export async function fetchKnowledgeTree(bridgeUrl: string, token?: string): Promise<KnowledgeTreeResponse> {
  const response = await fetch(`${bridgeUrl}/knowledge/tree`, {
    headers: buildAuthHeaders(token),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `知识库不可用 (${response.status})`));
  }
  return response.json() as Promise<KnowledgeTreeResponse>;
}


/** 创建知识库子节点 */
export async function createKnowledgeNode(
  bridgeUrl: string,
  parentId: string,
  name: string,
  token?: string,
): Promise<KnowledgeCreateNodeResponse> {
  const response = await fetch(`${bridgeUrl}/knowledge/nodes`, {
    method: "POST",
    headers: buildAuthHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ parentId, name }),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `创建节点失败 (${response.status})`));
  }
  return response.json() as Promise<KnowledgeCreateNodeResponse>;
}


/** 上传节点 markdown */
export async function uploadKnowledgeMarkdown(
  bridgeUrl: string,
  nodeId: string,
  file: File,
  token?: string,
): Promise<KnowledgeUploadContentResponse> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${bridgeUrl}/knowledge/nodes/${encodeURIComponent(nodeId)}/content`, {
    method: "POST",
    headers: buildAuthHeaders(token),
    body: form,
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `上传失败 (${response.status})`));
  }
  return response.json() as Promise<KnowledgeUploadContentResponse>;
}


/** 重命名知识库节点 */
export async function renameKnowledgeNode(
  bridgeUrl: string,
  nodeId: string,
  name: string,
  token?: string,
): Promise<KnowledgeRenameNodeResponse> {
  const response = await fetch(`${bridgeUrl}/knowledge/nodes/${encodeURIComponent(nodeId)}`, {
    method: "PATCH",
    headers: buildAuthHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `重命名失败 (${response.status})`));
  }
  return response.json() as Promise<KnowledgeRenameNodeResponse>;
}


/** 删除知识库节点 */
export async function deleteKnowledgeNode(
  bridgeUrl: string,
  nodeId: string,
  token?: string,
): Promise<{ ok: boolean; nodeId: string }> {
  const response = await fetch(`${bridgeUrl}/knowledge/nodes/${encodeURIComponent(nodeId)}`, {
    method: "DELETE",
    headers: buildAuthHeaders(token),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `删除失败 (${response.status})`));
  }
  return response.json() as Promise<{ ok: boolean; nodeId: string }>;
}


export type GgufGroupOption = {
  groupKey: string;
  displayLabel: string;
  folderPrefix: string;
  filenames: string[];
};


export type HfModelSummary = {
  repoId: string;
  displayName: string;
};


export type InstalledLocalModel = {
  id: string;
  author: string;
  modelSlug: string;
  label: string;
  displayName: string;
  defaultPrompt: string;
  weightsReady: boolean;
  repoId: string;
  ggufGroupKey: string;
  filenames: string[];
};


export type LocalLlmInstallStatus = {
  jobId: string;
  state: "running" | "done" | "error";
  progress: string;
  phase?: "queued" | "resolving" | "downloading" | "finalizing" | "done" | "error";
  totalBytes?: number | null;
  downloadedBytes?: number;
  percent?: number | null;
  error?: string;
  model?: InstalledLocalModel;
};


/** 获取 local-llm 作者列表 */
export async function fetchLocalLlmAuthors(bridgeUrl: string): Promise<{ authors: string[] }> {
  const response = await fetch(`${bridgeUrl}/local-llm/authors`);
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `获取作者列表失败 (${response.status})`));
  }
  return response.json() as Promise<{ authors: string[] }>;
}


/** 添加 HF 作者 */
export async function addLocalLlmAuthor(bridgeUrl: string, author: string): Promise<{ authors: string[] }> {
  const response = await fetch(`${bridgeUrl}/local-llm/authors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ author }),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `添加作者失败 (${response.status})`));
  }
  return response.json() as Promise<{ authors: string[] }>;
}


/** 列出作者的 HF GGUF 仓库 */
export async function fetchLocalLlmHfModels(
  bridgeUrl: string,
  author: string,
): Promise<{ author: string; models: HfModelSummary[] }> {
  const params = new URLSearchParams({ author });
  const response = await fetch(`${bridgeUrl}/local-llm/hf/models?${params.toString()}`);
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `获取 HF 模型失败 (${response.status})`));
  }
  return response.json() as Promise<{ author: string; models: HfModelSummary[] }>;
}


/** 列出仓库内 GGUF 分组 */
export async function fetchLocalLlmHfFiles(
  bridgeUrl: string,
  repoId: string,
): Promise<{ repoId: string; groups: GgufGroupOption[] }> {
  const params = new URLSearchParams({ repo_id: repoId });
  const response = await fetch(`${bridgeUrl}/local-llm/hf/files?${params.toString()}`);
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `获取 GGUF 文件失败 (${response.status})`));
  }
  return response.json() as Promise<{ repoId: string; groups: GgufGroupOption[] }>;
}


/** 开始安装本地模型（需指定 ggufGroupKey + filenames） */
export async function installLocalLlmModel(
  bridgeUrl: string,
  body: {
    author: string;
    repoId: string;
    ggufGroupKey?: string;
    filenames?: string[];
    displayName?: string;
    defaultPrompt?: string;
  },
): Promise<{ jobId: string }> {
  const response = await fetch(`${bridgeUrl}/local-llm/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `安装失败 (${response.status})`));
  }
  return response.json() as Promise<{ jobId: string }>;
}


/** 查询安装进度 */
export async function fetchLocalLlmInstallStatus(
  bridgeUrl: string,
  jobId: string,
): Promise<LocalLlmInstallStatus> {
  const response = await fetch(`${bridgeUrl}/local-llm/install/${encodeURIComponent(jobId)}`);
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `安装状态不可用 (${response.status})`));
  }
  return response.json() as Promise<LocalLlmInstallStatus>;
}


/** 已安装模型列表 */
export async function fetchLocalLlmInstalled(bridgeUrl: string): Promise<{ models: InstalledLocalModel[] }> {
  const response = await fetch(`${bridgeUrl}/local-llm/installed`);
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `获取已安装模型失败 (${response.status})`));
  }
  return response.json() as Promise<{ models: InstalledLocalModel[] }>;
}


function localLlmModelIdToRoutePath(modelId: string): string {
  return modelId
    .split("/")
    .map((segment) => encodeURIComponent(segment.trim()))
    .filter(Boolean)
    .join("/");
}


/** 删除已安装模型 */
export async function deleteLocalLlmModel(
  bridgeUrl: string,
  modelId: string,
): Promise<{ ok: boolean; unloaded?: boolean; deleted?: boolean }> {
  const url = `${bridgeUrl}/local-llm/installed/${localLlmModelIdToRoutePath(modelId)}`;
  const response = await fetch(url, {
    method: "DELETE",
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response, `删除模型失败 (${response.status})`);
    console.error("[deleteLocalLlmModel]", { url, modelId, status: response.status, detail });
    throw new Error(detail);
  }
  return response.json() as Promise<{ ok: boolean; unloaded?: boolean; deleted?: boolean }>;
}


/** 更新 defaultPrompt */
export async function patchLocalLlmDefaultPrompt(
  bridgeUrl: string,
  modelId: string,
  defaultPrompt: string,
): Promise<{ model: InstalledLocalModel }> {
  const response = await fetch(`${bridgeUrl}/local-llm/installed/${localLlmModelIdToRoutePath(modelId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defaultPrompt }),
  });
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `保存提示词失败 (${response.status})`));
  }
  return response.json() as Promise<{ model: InstalledLocalModel }>;
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
