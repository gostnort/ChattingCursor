import type { FastifyInstance } from "fastify";
import { listCursorModels, probeCursorCli } from "@chatting-cursor/cli-client";
import { loadConfig } from "../config.js";
import { isLocalRequest } from "../middleware/auth.js";
import { historyStore } from "../services/history-store.js";
import { tokenRotationService } from "../services/token-rotation.js";


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
      publicBridgeUrl: config.publicBridgeUrl,
      bridgeHost: config.host,
      bridgePort: config.port,
      corsOrigins: config.corsOrigins,
      historyDir: historyStore.getDirectory(),
      historyRetentionDays: historyStore.getRetentionDays(),
      tokenFilePath: tokenRotationService.getFilePath(),
      tokenDate: tokenRotationService.getToday(),
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


  app.get("/local/token-file", async (_request, reply) => {
    const tokenFile = await tokenRotationService.readTodayTokenFileContent();
    return reply.send({
      fileName: tokenFile.fileName,
      tokenDate: tokenFile.date,
      content: tokenFile.content,
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
