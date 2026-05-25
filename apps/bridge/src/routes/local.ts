import type { FastifyInstance, FastifyRequest } from "fastify";
import { listCursorModels, probeCursorCli } from "@chatting-cursor/cli-client";
import { loadConfig } from "../config.js";
import { historyStore } from "../services/history-store.js";


/** 判断请求是否来自本机（本地配置 API 仅 localhost 可用） */
function isLocalRequest(request: FastifyRequest): boolean {
  const address = request.ip;
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1"
    || address === "localhost";
}


/** 注册本地配置与历史浏览路由 */
export async function registerLocalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/local/")) {
      return;
    }
    if (!isLocalRequest(request)) {
      return reply.status(403).send({
        error: "local_only",
        message: "本地配置 API 仅允许本机访问",
      });
    }
  });


  app.get("/local/config", async (_request, reply) => {
    const config = loadConfig();
    const cli = await probeCursorCli();
    const models = await listCursorModels();
    const defaultModel = models.models.find((item) => item.isDefault)?.id ?? models.models[0]?.id ?? "";
    return reply.send({
      bridgeUrl: `http://${config.host}:${config.port}`,
      bridgeHost: config.host,
      bridgePort: config.port,
      corsOrigins: config.corsOrigins,
      historyDir: historyStore.getDirectory(),
      historyRetentionDays: historyStore.getRetentionDays(),
      defaultModel,
      modelsSource: models.source,
      cli,
      timestamp: new Date().toISOString(),
    });
  });


  app.get("/local/history", async (_request, reply) => {
    const sessions = await historyStore.listSessions();
    return reply.send({
      historyDir: historyStore.getDirectory(),
      retentionDays: historyStore.getRetentionDays(),
      sessions,
    });
  });


  app.get("/local/history/:file", async (request, reply) => {
    const { file } = request.params as { file: string };
    const content = await historyStore.readSessionFile(file);
    if (content === null) {
      return reply.status(404).send({ error: "history_not_found" });
    }
    return reply.send({ file, content });
  });
}
