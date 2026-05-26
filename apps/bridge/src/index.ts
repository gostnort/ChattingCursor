import Fastify from "fastify";
import cors from "@fastify/cors";
import { probeCursorCli } from "@chatting-cursor/cli-client";
import { loadConfig, isOriginAllowed } from "./config.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerCrewRoutes } from "./routes/crews.js";
import { registerLocalRoutes } from "./routes/local.js";
import { tokenRotationService } from "./services/token-rotation.js";


/** 启动本地 Bridge 服务 */
async function main(): Promise<void> {
  const config = loadConfig();
  await tokenRotationService.ensureTodayToken();
  const app = Fastify({ logger: true });
  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, isOriginAllowed(origin, config.corsOrigins));
    },
  });
  app.get("/health", async () => {
    const cli = await probeCursorCli();
    return {
      status: "ok",
      cli,
      publicBridgeUrl: tokenRotationService.getPublicBridgeUrl(),
      timestamp: new Date().toISOString(),
    };
  });
  await registerAuthRoutes(app);
  await registerChatRoutes(app);
  await registerCrewRoutes(app);
  await registerLocalRoutes(app);
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Bridge 运行于 http://${config.host}:${config.port}`);
}


main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
