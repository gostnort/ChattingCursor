import Fastify from "fastify";
import cors from "@fastify/cors";
import { probeCursorCli } from "@chatting-cursor/cli-client";
import { loadConfig, isOriginAllowed } from "./config.js";
import { registerChatRoutes } from "./routes/chat.js";


/** 启动本地 Bridge 服务 */
async function main(): Promise<void> {
  const config = loadConfig();
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
      timestamp: new Date().toISOString(),
    };
  });
  await registerChatRoutes(app);
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Bridge 运行于 http://${config.host}:${config.port}`);
}


main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
