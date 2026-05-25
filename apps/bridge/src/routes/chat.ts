import type { FastifyInstance, FastifyRequest } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { listCursorModels, mergeAssistantStreamText, probeCursorCli, runCursorCli } from "@chatting-cursor/cli-client";
import type { RunEvent } from "@chatting-cursor/shared";
import { chatSendRequestSchema } from "@chatting-cursor/shared";
import { loadConfig, resolveCorsOrigin } from "../config.js";
import {
  extractSearchKeywords,
  formatHistorySearchReply,
  hasHistorySearchIntent,
} from "../services/history-search-intent.js";
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


/** 完成一次仅搜索历史的 run（不调用 cursor-agent） */
function finishHistorySearchRun(
  runId: string,
  sessionId: string,
  prompt: string,
  replyText: string,
): void {
  runStore.appendEvent(runId, {
    runId,
    type: "run_started",
    timestamp: new Date().toISOString(),
    data: { source: "history_search", prompt },
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
  });
  runStore.appendEvent(runId, {
    runId,
    type: "run_finished",
    timestamp: new Date().toISOString(),
    data: { exitCode: 0, source: "history_search" },
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


  app.post("/chat/send", async (request, reply) => {
    const parsed = chatSendRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const cli = await probeCursorCli();
    if (!cli.available) {
      return reply.status(503).send({
        error: "cli_unavailable",
        message: cli.message ?? "Cursor Agent CLI 不可用",
      });
    }
    const session = sessionStore.getOrCreate(parsed.data.sessionId);
    const runId = uuidv4();
    runStore.create(runId);
    const { prompt, model, workspace } = parsed.data;
    const startedAt = new Date().toISOString();
    sessionStore.appendMessage(session.sessionId, {
      role: "user",
      content: prompt,
      timestamp: startedAt,
    });
    if (hasHistorySearchIntent(prompt)) {
      const query = extractSearchKeywords(prompt);
      void historyStore.search(query).then((hits) => {
        const replyText = formatHistorySearchReply(query, hits);
        finishHistorySearchRun(runId, session.sessionId, prompt, replyText);
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        finishHistorySearchRun(runId, session.sessionId, prompt, `搜索本地历史失败：${message}`);
      });
      return reply.send({ runId, sessionId: session.sessionId });
    }
    void runCursorCli({
      runId,
      prompt,
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
        sessionStore.appendMessage(session.sessionId, {
          role: "assistant",
          content: assistantText,
          timestamp: new Date().toISOString(),
        });
        await historyStore.appendTurn(session.sessionId, prompt, assistantText, session.createdAt);
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
    return reply.send({ runId, sessionId: session.sessionId });
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
