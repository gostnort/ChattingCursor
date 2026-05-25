import type { FastifyInstance, FastifyRequest } from "fastify";
import { crewRunRequestSchema } from "@chatting-cursor/shared";
import { probeCrewEnvironment, runCrew } from "@chatting-cursor/orchestrator";


/** crewAI 路由仅允许本机访问 */
function isLocalRequest(request: FastifyRequest): boolean {
  const address = request.ip;
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1"
    || address === "localhost";
}


/** 注册 crewAI 相关路由 */
export async function registerCrewRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/crews/")) {
      return;
    }
    if (!isLocalRequest(request)) {
      return reply.status(403).send({
        error: "local_only",
        message: "crewAI API 仅允许本机访问",
      });
    }
  });


  app.get("/crews/status", async (_request, reply) => {
    const status = await probeCrewEnvironment();
    return reply.send(status);
  });


  app.post("/crews/run", async (request, reply) => {
    const parsed = crewRunRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        message: parsed.error.message,
      });
    }
    const { crew, inputs, dryRun } = parsed.data;
    const result = await runCrew(crew, inputs, dryRun);
    if (result.exitCode !== 0) {
      return reply.status(500).send(result);
    }
    return reply.send(result);
  });
}
