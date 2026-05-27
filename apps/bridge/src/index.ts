import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { probeCursorCli } from "@chatting-cursor/cli-client";
import { loadConfig, isOriginAllowed } from "./config.js";
import { inspectChromeEndpoint } from "./services/chrome-google-search.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerChatRoutes } from "./routes/chat.js";
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
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 1,
    },
  });
  app.get("/health", async () => {
    const [cli, chrome] = await Promise.all([
      probeCursorCli(),
      inspectChromeEndpoint(),
    ]);
    return {
      status: "ok",
      cli,
      chrome,
      webSearchAvailable: chrome.available,
      publicBridgeUrl: tokenRotationService.getPublicBridgeUrl(),
      timestamp: new Date().toISOString(),
    };
  });
  await registerAuthRoutes(app);
  await registerChatRoutes(app);
  await registerLocalRoutes(app);
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Bridge 运行于 http://${config.host}:${config.port}`);
}


main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
