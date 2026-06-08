import type { FastifyInstance } from "fastify";
import { formatLocalLlmError, offlineWarmupRequestSchema } from "@chatting-cursor/shared";
import { requireRemoteToken } from "../middleware/auth.js";
import { ensureOfflineModelReady, getOfflineModelSnapshot } from "../services/offline-runtime.js";
import {
  getResourceSchedulerSnapshot,
  releaseOfflineStack,
} from "../services/resource-scheduler.js";


/** 注册离线模型预热与健康查询路由 */
export async function registerOfflineRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/offline/")) {
      return;
    }
    await requireRemoteToken(request, reply);
  });


  app.get("/offline/status", async (request, reply) => {
    const modelId = (request.query as { modelId?: string }).modelId?.trim() ?? "";
    if (!modelId) {
      return reply.status(400).send({
        error: "invalid_request",
        message: "缺少 query 参数 modelId",
      });
    }
    const snapshot = await getOfflineModelSnapshot(modelId);
    return reply.send(snapshot);
  });


  app.get("/offline/scheduler", async (_request, reply) => {
    return reply.send(getResourceSchedulerSnapshot());
  });


  app.post("/offline/release-stack", async (_request, reply) => {
    const stack = await releaseOfflineStack();
    return reply.send({ ok: true, ...stack });
  });


  app.post("/offline/warmup", async (request, reply) => {
    const parsed = offlineWarmupRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        message: parsed.error.message,
      });
    }
    try {
      const snapshot = await ensureOfflineModelReady(parsed.data.modelId);
      return reply.send(snapshot);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const snapshot = await getOfflineModelSnapshot(parsed.data.modelId);
      const formatted = formatLocalLlmError(message);
      return reply.status(503).send({
        ...snapshot,
        ready: false,
        message: formatted,
        error: formatLocalLlmError(snapshot.error ?? message),
      });
    }
  });
}
