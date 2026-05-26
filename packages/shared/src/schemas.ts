import { z } from "zod";

/** Agent 配置（借鉴 crewAI Agent 概念） */
export const agentSpecSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  goal: z.string().min(1),
  backstory: z.string().optional(),
  model: z.string().optional(),
});

export type AgentSpec = z.infer<typeof agentSpecSchema>;


/** Task 配置 */
export const taskSpecSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  description: z.string().min(1),
  expectedOutput: z.string().optional(),
  contextTaskIds: z.array(z.string()).optional(),
});

export type TaskSpec = z.infer<typeof taskSpecSchema>;


/** Crew 编排配置 */
export const crewProcessSchema = z.enum(["sequential", "hierarchical"]);

export const crewSpecSchema = z.object({
  name: z.string().min(1),
  process: crewProcessSchema.default("sequential"),
  agents: z.array(agentSpecSchema).min(1),
  tasks: z.array(taskSpecSchema).min(1),
});

export type CrewSpec = z.infer<typeof crewSpecSchema>;


/** 聊天消息 */
export const chatMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.string().datetime().optional(),
  modelLabel: z.string().optional(),
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


/** GET /models 单项 */
export const modelInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  isDefault: z.boolean().optional(),
});

export type ModelInfo = z.infer<typeof modelInfoSchema>;


/** GET /models 响应体 */
export const modelsResponseSchema = z.object({
  models: z.array(modelInfoSchema),
  source: z.enum(["cli", "fallback"]),
});

export type ModelsResponse = z.infer<typeof modelsResponseSchema>;


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
    command: z.string().optional(),
    message: z.string().optional(),
  }),
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


/** GET /crews/status 响应体 */
export const crewStatusResponseSchema = z.object({
  python: z.object({
    available: z.boolean(),
    command: z.string().optional(),
    message: z.string().optional(),
  }),
  crewai: z.object({
    installed: z.boolean(),
    version: z.string().optional(),
    message: z.string().optional(),
  }),
  chrome: z.object({
    available: z.boolean(),
    endpoint: z.string(),
    pages: z.number().int().nonnegative().optional(),
    message: z.string().optional(),
  }),
  exampleConfig: z.object({
    valid: z.boolean(),
    path: z.string().optional(),
    name: z.string().optional(),
    message: z.string().optional(),
  }),
  scriptPath: z.string().optional(),
  timestamp: z.string().datetime(),
});

export type CrewStatusResponse = z.infer<typeof crewStatusResponseSchema>;


/** POST /crews/run 请求体 */
export const crewRunRequestSchema = z.object({
  crew: z.string().min(1).default("example"),
  inputs: z.record(z.string()).default({}),
  dryRun: z.boolean().default(true),
});

export type CrewRunRequest = z.infer<typeof crewRunRequestSchema>;


/** POST /crews/run 响应体 */
export const crewRunResponseSchema = z.object({
  crew: z.string().min(1),
  dryRun: z.boolean(),
  exitCode: z.number().int(),
  output: z.string(),
  parsed: z.record(z.unknown()).optional(),
});

export type CrewRunResponse = z.infer<typeof crewRunResponseSchema>;
