import { z } from "zod";

/** 聊天消息 */
export const chatMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.string().datetime().optional(),
  modelLabel: z.string().optional(),
  imageUrl: z.string().optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;


/** CLI 运行事件类型 */
export const runEventTypeSchema = z.enum([
  "run_started",
  "stdout",
  "raw_stdout",
  "stderr",
  "assistant",
  "thinking",
  "tool_call",
  "result",
  "error",
  "run_finished",
]);

export type RunEventType = z.infer<typeof runEventTypeSchema>;


export const runEventSchema = z.object({
  runId: z.string().min(1),
  type: runEventTypeSchema,
  timestamp: z.string().datetime(),
  data: z.record(z.unknown()).optional(),
  text: z.string().optional(),
});

export type RunEvent = z.infer<typeof runEventSchema>;


/** POST /chat/send 请求体 */
export const chatSendRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  modelLabel: z.string().optional(),
  workspace: z.string().optional(),
  sessionId: z.string().optional(),
});

export type ChatSendRequest = z.infer<typeof chatSendRequestSchema>;


/** POST /chat/send 响应体 */
export const chatSendResponseSchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1),
});

export type ChatSendResponse = z.infer<typeof chatSendResponseSchema>;


/** POST /chat/cancel 请求体 */
export const chatCancelRequestSchema = z.object({
  runId: z.string().min(1),
});

export type ChatCancelRequest = z.infer<typeof chatCancelRequestSchema>;


/** POST /chat/cancel 响应体 */
export const chatCancelResponseSchema = z.object({
  cancelled: z.boolean(),
  status: z.string().optional(),
});

export type ChatCancelResponse = z.infer<typeof chatCancelResponseSchema>;


/** POST /chat/upload-image 响应体 */
export const chatImageUploadResponseSchema = z.object({
  imageId: z.string().min(1),
  sessionId: z.string().min(1),
  fileName: z.string().min(1),
  imageUrl: z.string().min(1),
});

export type ChatImageUploadResponse = z.infer<typeof chatImageUploadResponseSchema>;


/** POST /chat/analyze-image 请求体 */
export const chatAnalyzeImageRequestSchema = z.object({
  sessionId: z.string().min(1),
  imageId: z.string().min(1),
  fileName: z.string().min(1),
  model: z.string().optional(),
  modelLabel: z.string().optional(),
  workspace: z.string().optional(),
  /** 附件时输入框中的用户意图（尚未发送时） */
  userIntent: z.string().optional(),
});

export type ChatAnalyzeImageRequest = z.infer<typeof chatAnalyzeImageRequestSchema>;


/** POST /chat/analyze-image 响应体 */
export const chatAnalyzeImageResponseSchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  imageId: z.string().min(1),
  analysisText: z.string().min(1),
});

export type ChatAnalyzeImageResponse = z.infer<typeof chatAnalyzeImageResponseSchema>;


/** POST /chat/new-session 响应体 */
export const chatNewSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
});

export type ChatNewSessionResponse = z.infer<typeof chatNewSessionResponseSchema>;


/** GET /chat/recent-session 响应体 */
export const recentChatSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  model: z.string().optional(),
  messages: z.array(chatMessageSchema),
  updatedAt: z.string().datetime(),
});

export type RecentChatSessionResponse = z.infer<typeof recentChatSessionResponseSchema>;


/** GET /chat/latest-run 响应体 */
export const latestRunResponseSchema = z.object({
  runId: z.string().min(1),
  status: z.enum(["pending", "running", "finished", "error"]),
  updatedAt: z.string().datetime(),
});

export type LatestRunResponse = z.infer<typeof latestRunResponseSchema>;


/** GET /chat/runs/:runId/final-text 响应体 */
export const runFinalTextResponseSchema = z.object({
  runId: z.string().min(1),
  status: z.enum(["pending", "running", "finished", "error"]),
  text: z.string(),
});

export type RunFinalTextResponse = z.infer<typeof runFinalTextResponseSchema>;


/** GET /models 单项 */
export const modelInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  isDefault: z.boolean().optional(),
  /** cursor=走 agent-cli；offline=本地独立 LLM；separator=下拉分隔线 */
  kind: z.enum(["cursor", "offline", "separator"]).optional(),
});

export type ModelInfo = z.infer<typeof modelInfoSchema>;


/** GET /models 响应体 */
export const modelsResponseSchema = z.object({
  models: z.array(modelInfoSchema),
  source: z.enum(["cli", "fallback"]),
});

export type ModelsResponse = z.infer<typeof modelsResponseSchema>;


/** POST /offline/warmup 请求体 */
export const offlineWarmupRequestSchema = z.object({
  modelId: z.string().min(1),
});

export type OfflineWarmupRequest = z.infer<typeof offlineWarmupRequestSchema>;


/** POST /offline/warmup 响应体 */
export const offlineWarmupResponseSchema = z.object({
  modelId: z.string().min(1),
  runtime: z.string().min(1),
  ready: z.boolean(),
  spawning: z.boolean(),
  running: z.boolean(),
  weights: z.enum(["ready", "missing", "incomplete"]).optional(),
  loadState: z.enum(["down", "idle", "loading", "ready", "error"]).optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});

export type OfflineWarmupResponse = z.infer<typeof offlineWarmupResponseSchema>;


/** GET /history/search 匹配片段 */
export const historySearchHitSchema = z.object({
  file: z.string().min(1),
  snippet: z.string().min(1),
  line: z.number().int().positive().optional(),
});

export type HistorySearchHit = z.infer<typeof historySearchHitSchema>;


/** GET /history/search 响应体 */
export const historySearchResponseSchema = z.object({
  query: z.string(),
  hits: z.array(historySearchHitSchema),
});

export type HistorySearchResponse = z.infer<typeof historySearchResponseSchema>;


/** GET /local/config 响应体 */
export const localConfigResponseSchema = z.object({
  bridgeUrl: z.string().min(1),
  publicBridgeUrl: z.string().min(1),
  bridgeHost: z.string().min(1),
  bridgePort: z.number().int().positive(),
  corsOrigins: z.array(z.string()),
  historyDir: z.string().min(1),
  historyRetentionDays: z.number().int().positive(),
  tokenFilePath: z.string().min(1),
  tokenDate: z.string().min(1),
  defaultModel: z.string(),
  modelsSource: z.enum(["cli", "fallback"]),
  cli: z.object({
    available: z.boolean(),
    mode: z.enum(["native", "wsl", "none"]),
    requestedMode: z.string().optional(),
    command: z.string().optional(),
    message: z.string().optional(),
    fallbackFromNative: z.boolean().optional(),
  }),
  localLlm: z
    .object({
      managed: z.boolean(),
      baseUrl: z.string(),
      weights: z.enum(["ready", "missing", "incomplete"]),
      modelDir: z.string(),
      running: z.boolean(),
      spawning: z.boolean(),
      message: z.string().optional(),
    })
    .optional(),
  timestamp: z.string().datetime(),
});

export type LocalConfigResponse = z.infer<typeof localConfigResponseSchema>;


/** GET /auth/status 响应体 */
export const authStatusResponseSchema = z.object({
  enabled: z.boolean(),
  tokenDate: z.string().min(1),
  publicBridgeUrl: z.string().min(1),
  tokenFilePath: z.string().min(1),
  timestamp: z.string().datetime(),
});

export type AuthStatusResponse = z.infer<typeof authStatusResponseSchema>;


/** POST /auth/verify 响应体 */
export const authVerifyResponseSchema = z.object({
  ok: z.boolean(),
  tokenDate: z.string().min(1),
  timestamp: z.string().datetime(),
});

export type AuthVerifyResponse = z.infer<typeof authVerifyResponseSchema>;


/** POST /local/token-directory 请求体 */
export const localTokenDirectoryUpdateRequestSchema = z.object({
  directory: z.string().min(1),
});

export type LocalTokenDirectoryUpdateRequest = z.infer<typeof localTokenDirectoryUpdateRequestSchema>;


/** POST /local/token-directory 响应体 */
export const localTokenDirectoryUpdateResponseSchema = z.object({
  directory: z.string().min(1),
  fileName: z.string().min(1),
  filePath: z.string().min(1),
  tokenDate: z.string().min(1),
});

export type LocalTokenDirectoryUpdateResponse = z.infer<typeof localTokenDirectoryUpdateResponseSchema>;


/** POST /local/public-bridge-url 请求体 */
export const localPublicBridgeUrlUpdateRequestSchema = z.object({
  publicBridgeUrl: z.string().url(),
});

export type LocalPublicBridgeUrlUpdateRequest = z.infer<typeof localPublicBridgeUrlUpdateRequestSchema>;


/** POST /local/public-bridge-url 响应体 */
export const localPublicBridgeUrlUpdateResponseSchema = z.object({
  publicBridgeUrl: z.string().min(1),
  tokenFilePath: z.string().min(1),
  tokenDate: z.string().min(1),
});

export type LocalPublicBridgeUrlUpdateResponse = z.infer<typeof localPublicBridgeUrlUpdateResponseSchema>;


/** GET /local/token-file 响应体 */
export const localTokenFileResponseSchema = z.object({
  fileName: z.string().min(1),
  tokenDate: z.string().min(1),
  content: z.string(),
});

export type LocalTokenFileResponse = z.infer<typeof localTokenFileResponseSchema>;


/** POST /local/regenerate-token 响应体 */
export const localRegenerateTokenResponseSchema = z.object({
  tokenDate: z.string().min(1),
  tokenFilePath: z.string().min(1),
  publicBridgeUrl: z.string().min(1),
});

export type LocalRegenerateTokenResponse = z.infer<typeof localRegenerateTokenResponseSchema>;


/** GET /local/cloudflare-tunnel 与 POST 请求/响应体 */
export const cloudflareTunnelConfigSchema = z.object({
  tunnelName: z.string().optional(),
  accountId: z.string().optional(),
  publicHostname: z.string().optional(),
  credentialsFilePath: z.string().optional(),
  tunnelToken: z.string().optional(),
});

export type CloudflareTunnelConfig = z.infer<typeof cloudflareTunnelConfigSchema>;


export const localCloudflareTunnelResponseSchema = cloudflareTunnelConfigSchema.extend({
  configPath: z.string().min(1),
  namedTunnelEnabled: z.boolean(),
  publicBridgeUrl: z.string().optional(),
});

export type LocalCloudflareTunnelResponse = z.infer<typeof localCloudflareTunnelResponseSchema>;


/** GET /local/history 会话摘要 */
export const historySessionSummarySchema = z.object({
  file: z.string().min(1),
  sessionId: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: z.string().datetime(),
});

export type HistorySessionSummary = z.infer<typeof historySessionSummarySchema>;


/** GET /local/history 响应体 */
export const localHistoryListResponseSchema = z.object({
  historyDir: z.string().min(1),
  retentionDays: z.number().int().positive(),
  sessions: z.array(historySessionSummarySchema),
});

export type LocalHistoryListResponse = z.infer<typeof localHistoryListResponseSchema>;


/** GET /local/history/:file 响应体 */
export const localHistoryContentResponseSchema = z.object({
  file: z.string().min(1),
  content: z.string(),
});

export type LocalHistoryContentResponse = z.infer<typeof localHistoryContentResponseSchema>;


/** 知识库 wiki 节点 */
export const knowledgeNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parentId: z.string().nullable(),
  hasContent: z.boolean().optional(),
  tags: z.array(z.string().min(1).max(64)).optional(),
});

export type KnowledgeNode = z.infer<typeof knowledgeNodeSchema>;


/** GET /knowledge/tree 响应体 */
export const knowledgeTreeResponseSchema = z.object({
  knowledgeDir: z.string().min(1),
  nodes: z.array(knowledgeNodeSchema),
  rootId: z.string().min(1),
});

export type KnowledgeTreeResponse = z.infer<typeof knowledgeTreeResponseSchema>;


/** POST /knowledge/nodes 请求体 */
export const knowledgeCreateNodeRequestSchema = z.object({
  parentId: z.string().min(1),
  name: z.string().min(1).max(120),
});

export type KnowledgeCreateNodeRequest = z.infer<typeof knowledgeCreateNodeRequestSchema>;


/** POST /knowledge/nodes 响应体 */
export const knowledgeCreateNodeResponseSchema = z.object({
  node: knowledgeNodeSchema,
});

export type KnowledgeCreateNodeResponse = z.infer<typeof knowledgeCreateNodeResponseSchema>;


/** POST /knowledge/nodes/:id/content 响应体 */
export const knowledgeUploadContentResponseSchema = z.object({
  nodeId: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});

export type KnowledgeUploadContentResponse = z.infer<typeof knowledgeUploadContentResponseSchema>;


/** PATCH /knowledge/nodes/:id 请求体 */
export const knowledgeRenameNodeRequestSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  tags: z.array(z.string().min(1).max(64)).optional(),
}).refine((body) => body.name !== undefined || body.tags !== undefined, {
  message: "name 或 tags 至少提供一个",
});

export type KnowledgeRenameNodeRequest = z.infer<typeof knowledgeRenameNodeRequestSchema>;


/** PATCH /knowledge/nodes/:id 响应体 */
export const knowledgeRenameNodeResponseSchema = z.object({
  node: knowledgeNodeSchema,
});

export type KnowledgeRenameNodeResponse = z.infer<typeof knowledgeRenameNodeResponseSchema>;
