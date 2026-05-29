import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { listCursorModels, mergeAssistantStreamText, probeCursorCli, runCursorCli } from "@chatting-cursor/cli-client";
import type { RunEvent } from "@chatting-cursor/shared";
import {
  chatAnalyzeImageRequestSchema,
  chatSendRequestSchema,
} from "@chatting-cursor/shared";
import { analyzeUploadedImage, buildImageForwardPrompt } from "../services/image-analysis-service.js";
import { readStoredImage, saveUploadedImage } from "../services/image-store.js";
import { loadConfig, resolveCorsOrigin } from "../config.js";
import { requireRemoteToken } from "../middleware/auth.js";
import { openGoogleSearchInChrome } from "../services/chrome-google-search.js";
import {
  extractSearchKeywords,
  formatHistorySearchReply,
  hasHistorySearchIntent,
} from "../services/history-search-intent.js";
import {
  extractWebSearchQuery,
  extractWebSearchUserIntent,
  formatWebSearchReply,
  hasWebSearchIntent,
} from "../services/web-search-intent.js";
import { wrapCursorCliPrompt } from "../services/cli-conversation-guard.js";
import { historyStore } from "../services/history-store.js";
import { runStore } from "../services/run-store.js";
import { sessionStore } from "../services/session-store.js";


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


/** 完成一次不调用 cursor-agent 的直连回复 run */
function finishDirectReplyRun(
  runId: string,
  sessionId: string,
  prompt: string,
  replyText: string,
  source: "history_search" | "chrome_web_search",
  modelLabel?: string,
): void {
  runStore.appendEvent(runId, {
    runId,
    type: "run_started",
    timestamp: new Date().toISOString(),
    data: { source, prompt },
  });
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
  void runCursorCli({
    runId,
    prompt: wrapCursorCliPrompt(prompt),
    model,
    workspace,
    onEvent: (event) => {
      runStore.appendEvent(runId, event);
    },
  }).then(async () => {
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
  }).catch((error: unknown) => {
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
  });
}


/** 从 run 事件中提取最终 assistant 文本 */
function extractAssistantText(events: RunEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "assistant" && event.text) {
      text = mergeAssistantStreamText(text, event.text);
    }
    if (event.type === "result" && event.text) {
      text = event.text;
    }
  }
  return text;
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
    return reply.send(result);
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


  app.post("/chat/send", async (request, reply) => {
    const parsed = chatSendRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const { prompt, model, modelLabel, workspace } = parsed.data;
    const needsCursorCli = !hasHistorySearchIntent(prompt) && !hasWebSearchIntent(prompt);
    if (needsCursorCli) {
      const cli = await probeCursorCli();
      if (!cli.available) {
        return reply.status(503).send({
          error: "cli_unavailable",
          message: cli.message ?? "Cursor Agent CLI 不可用",
        });
      }
    }
    const session = sessionStore.getOrCreate(parsed.data.sessionId);
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
      const query = extractSearchKeywords(prompt);
      void historyStore.search(query).then((hits) => {
        const replyText = formatHistorySearchReply(query, hits);
        finishDirectReplyRun(runId, session.sessionId, prompt, replyText, "history_search", modelLabel);
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        finishDirectReplyRun(
          runId,
          session.sessionId,
          prompt,
          `搜索本地历史失败：${message}`,
          "history_search",
          modelLabel,
        );
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
      void openGoogleSearchInChrome(query, { userIntent: userIntent || undefined }).then((result) => {
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
        const replyText = formatWebSearchReply(userIntent || query, result);
        finishDirectReplyRun(runId, session.sessionId, prompt, replyText, "chrome_web_search", modelLabel);
      }).catch((error: unknown) => {
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
    const cli = await probeCursorCli();
    if (!cli.available) {
      return reply.status(503).send({
        error: "cli_unavailable",
        message: cli.message ?? "Cursor Agent CLI is not available",
      });
    }
    const { sessionId, imageId, fileName, model, modelLabel, workspace, userIntent } = parsed.data;
    const session = sessionStore.getOrCreate(sessionId);
    const stored = await readStoredImage(sessionId, imageId);
    if (!stored) {
      return reply.status(404).send({ error: "image_not_found" });
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
    const runId = uuidv4();
    runStore.create(runId);
    const startedAt = new Date().toISOString();
    sessionStore.setModel(session.sessionId, model);
    sessionStore.appendMessage(session.sessionId, {
      role: "user",
      content: forwardPrompt,
      timestamp: startedAt,
      imageUrl: `/chat/uploads/${sessionId}/${imageId}`,
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
