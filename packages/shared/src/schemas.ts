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
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;


/** CLI 运行事件类型 */
export const runEventTypeSchema = z.enum([
  "run_started",
  "stdout",
  "raw_stdout",
  "stderr",
  "assistant",
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
