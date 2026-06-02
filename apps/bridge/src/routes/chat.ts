import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { listCursorModels, probeCursorCli, runCursorCli } from "@chatting-cursor/cli-client";
import type { RunEvent } from "@chatting-cursor/shared";
import {
  formatLocalLlmError,
  formatModelDropdownLabel,
} from "@chatting-cursor/shared";
import {
  chatAnalyzeImageRequestSchema,
  chatCancelRequestSchema,
  chatSendRequestSchema,
} from "@chatting-cursor/shared";
import {
  buildLocalLlmMessages,
  completeLocalLlmChat,
  imageFileToDataUrl,
  isLocalLlmModel,
} from "../services/local-llm-client.js";
import { probeLocalLlmLoadState } from "../services/local-llm-lifecycle.js";
import { analyzeUploadedImage, buildImageForwardPrompt } from "../services/image-analysis-service.js";
import { readStoredImage, saveUploadedImage } from "../services/image-store.js";
import { loadConfig, resolveCorsOrigin } from "../config.js";
import { requireRemoteToken } from "../middleware/auth.js";
import { openGoogleSearchInChrome } from "../services/chrome-google-search.js";
import { collectHistoryData } from "../services/collect-history-data.js";
import { collectKnowledgeByTags } from "../services/collect-knowledge-by-tags.js";
import {
  hasHistorySearchIntent,
} from "../services/history-search-intent.js";
import {
  listAllKnowledgeTags,
} from "../services/knowledge-store.js";
import { shouldRunKnowledgeTagPipeline } from "../services/knowledge-tag-intent.js";
import {
  runExternalDataPipeline,
  WEBSEARCH_SYNTHESIS_DEADLINE_MS,
} from "../services/external-data-pipeline.js";
import { ensureLocalLlmSidecarStarted } from "../services/local-llm-lifecycle.js";
import {
  extractWebSearchQuery,
  extractWebSearchUserIntent,
  formatWebSearchReply,
  hasWebSearchIntent,
} from "../services/web-search-intent.js";
import { buildCliPromptFromSession } from "../services/cli-conversation-context.js";
import { wrapCursorCliPrompt } from "../services/cli-conversation-guard.js";
import { historyStore } from "../services/history-store.js";
import { runStore } from "../services/run-store.js";
import { sessionStore } from "../services/session-store.js";
import { listInstalledLocalLlmModels } from "../services/local-llm-store.js";
import {
  cancelActiveRun,
  registerActiveRun,
  unregisterActiveRun,
} from "../services/active-run-registry.js";
import { extractAssistantText } from "../services/run-final-text.js";


/** 构建 SSE 响应头（hijack 后需手动写入 CORS） */
function buildSseHeaders(request: FastifyRequest): Record<string, string> {
  const config = loadConfig();
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
  const origin = resolveCorsOrigin(request.headers.origin, config.corsOrigins);
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return headers;
}


/** 终端 SSE 仅转发原始 CLI 输出相关事件 */
const TERMINAL_EVENT_TYPES = new Set<RunEvent["type"]>([
  "run_started",
  "raw_stdout",
  "stderr",
  "run_finished",
]);


type DirectReplySource =
  | "history_search"
  | "knowledge_search"
  | "chrome_web_search"
  | "offline_gemma4";


/** 写入直连回复的 result 与 run_finished（run_started 须由调用方先发） */
function emitDirectReplyResult(
  runId: string,
  sessionId: string,
  replyText: string,
  source: DirectReplySource,
  modelLabel?: string,
): void {
  runStore.appendEvent(runId, {
    runId,
    type: "result",
    timestamp: new Date().toISOString(),
    text: replyText,
  });
  sessionStore.appendMessage(sessionId, {
    role: "assistant",
    content: replyText,
    timestamp: new Date().toISOString(),
    modelLabel,
  });
  runStore.appendEvent(runId, {
    runId,
    type: "run_finished",
    timestamp: new Date().toISOString(),
    data: { exitCode: 0, source },
  });
}


/** 完成一次不调用 cursor-agent 的直连回复 run */
function finishDirectReplyRun(
  runId: string,
  sessionId: string,
  prompt: string,
  replyText: string,
  source: DirectReplySource,
  modelLabel?: string,
): void {
  runStore.appendEvent(runId, {
    runId,
    type: "run_started",
    timestamp: new Date().toISOString(),
    data: { source, prompt },
  });
  emitDirectReplyResult(runId, sessionId, replyText, source, modelLabel);
}


/** 采集外部资料后经 LLM-1/LLM-2 管线生成直连回复 */
function scheduleExternalDataPipelineRun(options: {
  runId: string;
  sessionId: string;
  prompt: string;
  model?: string;
  workspace?: string;
  modelLabel?: string;
  source: DirectReplySource;
  sourceKind: "history" | "knowledge" | "web";
  collect: () => Promise<{ chunks: import("../services/external-data-pipeline.js").CollectedChunk[]; query: string; userIntent: string }>;
  failurePrefix: string;
}): void {
  const {
    runId,
    sessionId,
    prompt,
    model,
    workspace,
    modelLabel,
    source,
    sourceKind,
    collect,
    failurePrefix,
  } = options;
  if (model && isLocalLlmModel(model)) {
    void ensureLocalLlmSidecarStarted(model).catch(() => undefined);
  }
  let skipResult = false;
  registerActiveRun(runId, () => {
    skipResult = true;
  });
  void (async () => {
    try {
      const collected = await collect();
      unregisterActiveRun(runId);
      if (skipResult) {
        finishCancelledRun({ runId, sessionId, prompt, modelLabel, source });
        return;
      }
      const replyText = await runExternalDataPipeline(
        {
          chunks: collected.chunks,
          userIntent: collected.userIntent,
          query: collected.query,
          fullPrompt: prompt,
          sourceKind,
        },
        {
          model,
          workspace,
          synthesisDeadlineMs: Date.now() + WEBSEARCH_SYNTHESIS_DEADLINE_MS,
        },
      );
      const finalText = replyText?.trim()
        || `未能生成回答。${failurePrefix}`;
      finishDirectReplyRun(runId, sessionId, prompt, finalText, source, modelLabel);
      void historyStore.appendTurn(sessionId, prompt, finalText, sessionStore.getOrCreate(sessionId).createdAt);
    } catch (error: unknown) {
      unregisterActiveRun(runId);
      if (skipResult) {
        finishCancelledRun({ runId, sessionId, prompt, modelLabel, source });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      finishDirectReplyRun(
        runId,
        sessionId,
        prompt,
        `${failurePrefix}：${message}`,
        source,
        modelLabel,
      );
    }
  })();
}


/** 启动本地 LLM 离线推理（OpenAI 兼容 API，不走 CLI） */
function scheduleLocalLlmRun(options: {
  runId: string;
  sessionId: string;
  prompt: string;
  modelId: string;
  modelLabel?: string;
  imageDataUrl?: string;
}): void {
  const { runId, sessionId, prompt, modelId, modelLabel, imageDataUrl } = options;
  const config = loadConfig();
  const bridgeOrigin = `http://${config.host}:${config.port}`;
  const startedAt = new Date().toISOString();
  runStore.appendEvent(runId, {
    runId,
    type: "run_started",
    timestamp: startedAt,
    data: { source: "offline_local_llm", prompt, modelId },
  });
  runStore.appendEvent(runId, {
    runId,
    type: "thinking",
    timestamp: startedAt,
    data: { source: "offline_local_llm", status: "loading" },
  });
  void ensureLocalLlmSidecarStarted(modelId).catch(() => undefined);
  const loadPollTimer = setInterval(() => {
    void probeLocalLlmLoadState().then((probe) => {
      if (probe.state === "error") {
        const formatted = formatLocalLlmError(probe.detail ?? "本地模型加载失败");
        runStore.appendEvent(runId, {
          runId,
          type: "error",
          timestamp: new Date().toISOString(),
          text: formatted,
          data: { source: "offline_local_llm", status: "error" },
        });
        return;
      }
      if (probe.state !== "loading" && probe.state !== "idle") {
        return;
      }
      const detail = probe.detail
        ?? (probe.healthDetail?.loadElapsedSec
          ? `已等待 ${probe.healthDetail.loadElapsedSec} 秒`
          : undefined);
      runStore.appendEvent(runId, {
        runId,
        type: "thinking",
        timestamp: new Date().toISOString(),
        data: {
          source: "offline_local_llm",
          status: probe.state,
          detail,
          mode: probe.healthDetail?.mode,
          ggufGb: probe.healthDetail?.ggufGb,
        },
      });
    }).catch(() => undefined);
  }, 2500);
  const abortController = new AbortController();
  registerActiveRun(runId, () => {
    abortController.abort();
  });
  void (async () => {
    try {
      const session = sessionStore.getOrCreate(sessionId);
      const messages = await buildLocalLlmMessages({
        prompt,
        history: session.messages,
        imageDataUrl,
        bridgeOrigin,
        modelId,
      });
      const replyText = await completeLocalLlmChat(modelId, messages, abortController.signal);
      emitDirectReplyResult(runId, sessionId, replyText, "offline_gemma4", modelLabel);
      await historyStore.appendTurn(sessionId, prompt, replyText, session.createdAt);
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        finishCancelledRun({
          runId,
          sessionId,
          prompt,
          modelLabel,
          source: "offline_gemma4",
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const formatted = formatLocalLlmError(message);
      runStore.appendEvent(runId, {
        runId,
        type: "error",
        timestamp: new Date().toISOString(),
        text: formatted,
        data: { source: "offline_local_llm" },
      });
      emitDirectReplyResult(
        runId,
        sessionId,
        formatted.startsWith("本地模型") ? formatted : `本地模型推理失败：${formatted}`,
        "offline_gemma4",
        modelLabel,
      );
    } finally {
      clearInterval(loadPollTimer);
      unregisterActiveRun(runId);
    }
  })();
}


/** 在会话中记录用户消息后启动 cursor-agent CLI run */
function scheduleCursorCliRun(options: {
  runId: string;
  sessionId: string;
  prompt: string;
  model?: string;
  modelLabel?: string;
  workspace?: string;
}): void {
  const { runId, sessionId, prompt, model, modelLabel, workspace } = options;
  void (async () => {
    const session = sessionStore.getOrCreate(sessionId);
    const fullPrompt = await buildCliPromptFromSession({
      prompt,
      history: session.messages,
    });
    try {
      await runCursorCli({
        runId,
        prompt: wrapCursorCliPrompt(fullPrompt),
        model,
        workspace,
        onEvent: (event) => {
          runStore.appendEvent(runId, event);
        },
        onChild: (child) => {
          registerActiveRun(runId, () => {
            child.kill("SIGTERM");
          });
        },
      });
      unregisterActiveRun(runId);
      const run = runStore.get(runId);
      if (!run) {
        return;
      }
      const assistantText = extractAssistantText(run.events);
      if (assistantText) {
        sessionStore.appendMessage(sessionId, {
          role: "assistant",
          content: assistantText,
          timestamp: new Date().toISOString(),
          modelLabel,
        });
        await historyStore.appendTurn(sessionId, prompt, assistantText, sessionStore.getOrCreate(sessionId).createdAt);
      }
    } catch (error: unknown) {
      unregisterActiveRun(runId);
      const message = error instanceof Error ? error.message : String(error);
      runStore.appendEvent(runId, {
        runId,
        type: "error",
        timestamp: new Date().toISOString(),
        text: message,
      });
      runStore.appendEvent(runId, {
        runId,
        type: "run_finished",
        timestamp: new Date().toISOString(),
        data: { exitCode: 1 },
      });
    }
  })();
}


/** 用户停止 run：保留已流式输出的 assistant 片段并结束 run */
function finishCancelledRun(options: {
  runId: string;
  sessionId: string;
  prompt: string;
  modelLabel?: string;
  source: DirectReplySource;
}): void {
  const { runId, sessionId, prompt, modelLabel, source } = options;
  const run = runStore.get(runId);
  if (!run || run.status === "finished" || run.status === "error") {
    return;
  }
  const partial = extractAssistantText(run.events);
  if (partial) {
    emitDirectReplyResult(runId, sessionId, partial, source, modelLabel);
    void historyStore.appendTurn(sessionId, prompt, partial, sessionStore.getOrCreate(sessionId).createdAt);
    return;
  }
  runStore.appendEvent(runId, {
    runId,
    type: "run_finished",
    timestamp: new Date().toISOString(),
    data: { exitCode: null, cancelled: true, source },
  });
}


/** 注册聊天相关路由 */
export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  await historyStore.cleanupOldFiles();
  app.addHook("onRequest", async (request, reply) => {
    const needsAuth = request.url === "/models"
      || request.url.startsWith("/chat/")
      || request.url.startsWith("/history/search");
    if (!needsAuth) {
      return;
    }
    await requireRemoteToken(request, reply);
  });


  app.post("/chat/new-session", async (_request, reply) => {
    const session = sessionStore.create();
    return reply.send({ sessionId: session.sessionId });
  });


  app.get("/models", async (_request, reply) => {
    const result = await listCursorModels();
    const cursorModels = result.models.map((item) => ({
      ...item,
      kind: "cursor" as const,
    }));
    const installed = await listInstalledLocalLlmModels();
    const localModels = installed
      .filter((item) => item.weightsReady)
      .map((item) => ({
        id: item.id,
        label: formatModelDropdownLabel(item.author, item.modelSlug),
        kind: "offline" as const,
      }));
    const separator = localModels.length > 0
      ? [{ id: "__separator__", label: "── 在线模型 ──", kind: "separator" as const }]
      : [];
    return reply.send({
      models: [...localModels, ...separator, ...cursorModels],
      source: result.source,
    });
  });


  app.get("/history/search", async (request, reply) => {
    const query = (request.query as { q?: string }).q ?? "";
    const hits = await historyStore.search(query);
    return reply.send({ query, hits });
  });


  app.get("/chat/recent-session", async (_request, reply) => {
    const session = sessionStore.getRecent();
    if (!session || session.messages.length === 0) {
      return reply.status(404).send({ error: "recent_session_not_found" });
    }
    return reply.send({
      sessionId: session.sessionId,
      model: session.model,
      updatedAt: session.updatedAt,
      messages: session.messages.map((message, index) => ({
        id: `${session.sessionId}-${index}`,
        role: message.role,
        content: message.content,
        createdAt: message.timestamp,
        modelLabel: message.modelLabel,
        imageUrl: message.imageUrl,
      })),
    });
  });


  app.get("/chat/latest-run", async (_request, reply) => {
    const run = runStore.getRecent();
    if (!run) {
      return reply.status(404).send({ error: "latest_run_not_found" });
    }
    return reply.send({
      runId: run.runId,
      status: run.status,
      updatedAt: run.updatedAt,
    });
  });


  app.get("/chat/runs/:runId/final-text", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = runStore.get(runId);
    if (!run) {
      return reply.status(404).send({ error: "run_not_found" });
    }
    return reply.send({
      runId: run.runId,
      status: run.status,
      text: extractAssistantText(run.events),
    });
  });


  app.post("/chat/cancel", async (request, reply) => {
    const parsed = chatCancelRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const { runId } = parsed.data;
    const run = runStore.get(runId);
    if (!run) {
      return reply.status(404).send({ error: "run_not_found" });
    }
    if (run.status === "finished" || run.status === "error") {
      return reply.send({ cancelled: false, status: run.status });
    }
    const cancelled = cancelActiveRun(runId);
    return reply.send({ cancelled, status: run.status });
  });


  app.post("/chat/send", async (request, reply) => {
    const parsed = chatSendRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const { prompt, model, modelLabel, workspace } = parsed.data;
    const useLocalLlm = isLocalLlmModel(model);
    const session = sessionStore.getOrCreate(parsed.data.sessionId);
    const knownKnowledgeTags = await listAllKnowledgeTags();
    const knowledgeTagPipeline = !hasHistorySearchIntent(prompt)
      && !hasWebSearchIntent(prompt)
      && shouldRunKnowledgeTagPipeline(prompt, knownKnowledgeTags, session.messages);
    const needsCursorCli = !useLocalLlm
      && !hasHistorySearchIntent(prompt)
      && !hasWebSearchIntent(prompt)
      && !knowledgeTagPipeline;
    if (needsCursorCli) {
      const cli = await probeCursorCli();
      if (!cli.available) {
        return reply.status(503).send({
          error: "cli_unavailable",
          message: cli.message ?? "Cursor Agent CLI 不可用",
        });
      }
    }
    const runId = uuidv4();
    runStore.create(runId);
    const startedAt = new Date().toISOString();
    sessionStore.setModel(session.sessionId, model);
    sessionStore.appendMessage(session.sessionId, {
      role: "user",
      content: prompt,
      timestamp: startedAt,
    });
    if (hasHistorySearchIntent(prompt)) {
      scheduleExternalDataPipelineRun({
        runId,
        sessionId: session.sessionId,
        prompt,
        model,
        workspace,
        modelLabel,
        source: "history_search",
        sourceKind: "history",
        failurePrefix: "搜索本地历史失败",
        collect: () => collectHistoryData(
          session.sessionId,
          session.messages,
          prompt,
          historyStore,
        ),
      });
      return reply.send({ runId, sessionId: session.sessionId });
    }
    if (knowledgeTagPipeline) {
      scheduleExternalDataPipelineRun({
        runId,
        sessionId: session.sessionId,
        prompt,
        model,
        workspace,
        modelLabel,
        source: "knowledge_search",
        sourceKind: "knowledge",
        failurePrefix: "知识库标签检索失败",
        collect: () => collectKnowledgeByTags(prompt, session.messages),
      });
      return reply.send({ runId, sessionId: session.sessionId });
    }
    if (hasWebSearchIntent(prompt)) {
      const query = extractWebSearchQuery(prompt);
      const userIntent = extractWebSearchUserIntent(prompt, session.messages);
      request.log.info(
        { query, userIntent: userIntent || undefined, endpoint: "http://127.0.0.1:9222", path: "chrome-google-search" },
        "Windows CDP search (Bridge → Chrome 9222, not WSL MCP)",
      );
      if (useLocalLlm && model) {
        void ensureLocalLlmSidecarStarted(model).catch(() => undefined);
      }
      let skipWebResult = false;
      registerActiveRun(runId, () => {
        skipWebResult = true;
      });
      void openGoogleSearchInChrome(query, {
        userIntent: userIntent || undefined,
        fullPrompt: prompt,
        sessionMessages: session.messages,
        model,
        workspace,
        runId,
      }).then((result) => {
        unregisterActiveRun(runId);
        if (skipWebResult) {
          finishCancelledRun({
            runId,
            sessionId: session.sessionId,
            prompt,
            modelLabel,
            source: "chrome_web_search",
          });
          return;
        }
        request.log.info(
          {
            query,
            ok: result.ok,
            serpStartOffsets: result.meta.serpStartOffsets,
            isRepeatSearch: result.meta.isRepeatSearch,
            linksQueued: result.meta.linksQueued,
            linksCrawled: result.meta.linksCrawled,
            crawlBatchCount: result.meta.crawlBatchCount,
            statePath: result.meta.statePath,
          },
          "websearch finished",
        );
        const replyText = formatWebSearchReply(userIntent || query, result, prompt);
        finishDirectReplyRun(runId, session.sessionId, prompt, replyText, "chrome_web_search", modelLabel);
      }).catch((error: unknown) => {
        unregisterActiveRun(runId);
        if (skipWebResult) {
          finishCancelledRun({
            runId,
            sessionId: session.sessionId,
            prompt,
            modelLabel,
            source: "chrome_web_search",
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        finishDirectReplyRun(
          runId,
          session.sessionId,
          prompt,
          `Chrome 联网搜索失败：${message}`,
          "chrome_web_search",
          modelLabel,
        );
      });
      return reply.send({ runId, sessionId: session.sessionId });
    }
    if (useLocalLlm && model) {
      scheduleLocalLlmRun({
        runId,
        sessionId: session.sessionId,
        prompt,
        modelId: model,
        modelLabel,
      });
      return reply.send({ runId, sessionId: session.sessionId });
    }
    scheduleCursorCliRun({
      runId,
      sessionId: session.sessionId,
      prompt,
      model,
      modelLabel,
      workspace,
    });
    return reply.send({ runId, sessionId: session.sessionId });
  });


  app.post("/chat/upload-image", async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.status(400).send({ error: "missing_file", message: "Expected multipart field 'file'" });
    }
    const sessionField = file.fields.sessionId;
    const sessionIdFromField = sessionField && "value" in sessionField
      ? String(sessionField.value).trim()
      : "";
    const session = sessionStore.getOrCreate(sessionIdFromField || undefined);
    const imageId = uuidv4();
    const mime = (file.mimetype || "").toLowerCase();
    if (mime !== "image/jpeg" && mime !== "image/png") {
      return reply.status(400).send({ error: "unsupported_type", message: "Only JPEG and PNG images are supported" });
    }
    try {
      const stored = await saveUploadedImage(session.sessionId, imageId, file);
      const imageUrl = `/chat/uploads/${session.sessionId}/${stored.imageId}`;
      return reply.send({
        imageId: stored.imageId,
        sessionId: stored.sessionId,
        fileName: stored.fileName,
        imageUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: "upload_failed", message });
    }
  });


  app.get("/chat/uploads/:sessionId/:imageId", async (request, reply) => {
    const { sessionId, imageId } = request.params as { sessionId: string; imageId: string };
    const stored = await readStoredImage(sessionId, imageId);
    if (!stored) {
      return reply.status(404).send({ error: "image_not_found" });
    }
    reply.header("Content-Type", stored.mimeType);
    reply.header("Cache-Control", "private, max-age=3600");
    return reply.send(createReadStream(stored.absolutePath));
  });


  app.post("/chat/analyze-image", async (request, reply) => {
    const parsed = chatAnalyzeImageRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const { sessionId, imageId, fileName, model, modelLabel, workspace, userIntent } = parsed.data;
    const useLocalLlm = isLocalLlmModel(model);
    if (!useLocalLlm) {
      const cli = await probeCursorCli();
      if (!cli.available) {
        return reply.status(503).send({
          error: "cli_unavailable",
          message: cli.message ?? "Cursor Agent CLI is not available",
        });
      }
    }
    const session = sessionStore.getOrCreate(sessionId);
    const stored = await readStoredImage(sessionId, imageId);
    if (!stored) {
      return reply.status(404).send({ error: "image_not_found" });
    }
    const runId = uuidv4();
    runStore.create(runId);
    const startedAt = new Date().toISOString();
    const imageUrl = `/chat/uploads/${sessionId}/${imageId}`;
    sessionStore.setModel(session.sessionId, model);
    if (useLocalLlm && model) {
      const userPrompt = userIntent?.trim()
        || "请描述这张图片中的内容，并回答用户可能关心的问题。";
      const displayContent = userIntent?.trim()
        ? `${userIntent.trim()}\n\n[图片]`
        : "[图片]";
      sessionStore.appendMessage(session.sessionId, {
        role: "user",
        content: displayContent,
        timestamp: startedAt,
        imageUrl,
      });
      let analysisText = "";
      try {
        const imageDataUrl = await imageFileToDataUrl(stored.absolutePath, stored.mimeType);
        scheduleLocalLlmRun({
          runId,
          sessionId: session.sessionId,
          prompt: userPrompt,
          modelId: model,
          modelLabel,
          imageDataUrl,
        });
        analysisText = "（由本地模型多模态理解图片）";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(502).send({ error: "analysis_failed", message });
      }
      return reply.send({
        runId,
        sessionId: session.sessionId,
        imageId,
        analysisText,
      });
    }
    let analysisText: string;
    try {
      analysisText = await analyzeUploadedImage({
        absolutePath: stored.absolutePath,
        mimeType: stored.mimeType,
        fileName,
        messages: session.messages,
        model,
        workspace,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(502).send({ error: "analysis_failed", message });
    }
    const forwardPrompt = buildImageForwardPrompt(
      analysisText,
      fileName,
      session.messages,
      userIntent,
    );
    sessionStore.appendMessage(session.sessionId, {
      role: "user",
      content: forwardPrompt,
      timestamp: startedAt,
      imageUrl,
    });
    scheduleCursorCliRun({
      runId,
      sessionId: session.sessionId,
      prompt: forwardPrompt,
      model,
      modelLabel,
      workspace,
    });
    return reply.send({
      runId,
      sessionId: session.sessionId,
      imageId,
      analysisText,
    });
  });


  app.get("/chat/stream/:runId", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = runStore.get(runId);
    if (!run) {
      return reply.status(404).send({ error: "run_not_found" });
    }
    reply.hijack();
    reply.raw.writeHead(200, buildSseHeaders(request));
    const writeEvent = (event: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      const raw = reply.raw as NodeJS.WritableStream & { flush?: () => void };
      raw.flush?.();
    };
    for (const event of run.events) {
      writeEvent(event);
    }
    if (run.status === "finished" || run.status === "error") {
      reply.raw.end();
      return reply;
    }
    const unsubscribe = runStore.subscribe(runId, (event) => {
      writeEvent(event);
      if (event.type === "run_finished") {
        unsubscribe?.();
        reply.raw.end();
      }
    });
    request.raw.on("close", () => {
      unsubscribe?.();
    });
    return reply;
  });


  app.get("/chat/terminal/:runId", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = runStore.get(runId);
    if (!run) {
      return reply.status(404).send({ error: "run_not_found" });
    }
    reply.hijack();
    reply.raw.writeHead(200, buildSseHeaders(request));
    const writeEvent = (event: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of run.events) {
      if (TERMINAL_EVENT_TYPES.has(event.type)) {
        writeEvent(event);
      }
    }
    if (run.status === "finished" || run.status === "error") {
      reply.raw.end();
      return reply;
    }
    const unsubscribe = runStore.subscribe(runId, (event) => {
      if (!TERMINAL_EVENT_TYPES.has(event.type)) {
        return;
      }
      writeEvent(event);
      if (event.type === "run_finished") {
        unsubscribe?.();
        reply.raw.end();
      }
    });
    request.raw.on("close", () => {
      unsubscribe?.();
    });
    return reply;
  });
}
