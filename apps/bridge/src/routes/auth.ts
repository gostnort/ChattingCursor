import type { FastifyInstance } from "fastify";
import { tokenRotationService } from "../services/token-rotation.js";


/** 注册远程口令相关路由 */
export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/auth/status", async (_request, reply) => {
    const record = await tokenRotationService.ensureTodayToken();
    return reply.send({
      enabled: true,
      tokenDate: record.date,
      publicBridgeUrl: tokenRotationService.getPublicBridgeUrl(),
      tokenFilePath: record.filePath,
      timestamp: new Date().toISOString(),
    });
  });


  app.post("/auth/verify", async (request, reply) => {
    const authorization = request.headers.authorization?.trim() ?? "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    const valid = await tokenRotationService.verifyToken(token);
    if (!valid) {
      return reply.status(401).send({
        error: "unauthorized",
        message: "当天口令不正确。",
      });
    }
    const record = await tokenRotationService.ensureTodayToken();
    return reply.send({
      ok: true,
      tokenDate: record.date,
      timestamp: new Date().toISOString(),
    });
  });
}
