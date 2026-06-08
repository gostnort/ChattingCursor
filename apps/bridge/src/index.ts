import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { probeCursorCli } from "@chatting-cursor/cli-client";
import { loadConfig, isOriginAllowed } from "./config.js";
import { inspectChromeEndpoint } from "./services/chrome-google-search.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerLocalRoutes } from "./routes/local.js";
import { registerKnowledgeRoutes } from "./routes/knowledge.js";
import { registerOfflineRoutes } from "./routes/offline.js";
import { registerLocalLlmRoutes } from "./routes/local-llm.js";
import { registerTtsRoutes } from "./routes/tts.js";
import { registerLocalVlmRoutes } from "./routes/local-vlm.js";
import { maybeWarmLocalLlmOnBridgeStart, stopManagedLocalLlm, getLocalLlmHealthStatus } from "./services/local-llm-lifecycle.js";
import { getResourceSchedulerSnapshot, initializeResourceSchedulerOnBridgeStart } from "./services/resource-scheduler.js";
import { releasePilotTtsLane } from "./services/pilot-tts-lifecycle.js";
import { runLocalLlmStartupMaintenance } from "./services/local-llm-store.js";
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
    // 浏览器从 Vite(43210) 跨域调用 DELETE/PATCH 时会先发 OPTIONS 预检
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 1,
    },
  });
  app.get("/health", async () => {
    const [cli, chrome, localLlm] = await Promise.all([
      probeCursorCli(),
      inspectChromeEndpoint(),
      getLocalLlmHealthStatus(),
    ]);
    const scheduler = getResourceSchedulerSnapshot();
    return {
      status: "ok",
      cli,
      chrome,
      localLlm,
      scheduler,
      webSearchAvailable: chrome.available,
      publicBridgeUrl: tokenRotationService.getPublicBridgeUrl(),
      timestamp: new Date().toISOString(),
    };
  });
  await registerAuthRoutes(app);
  await registerChatRoutes(app);
  await registerLocalRoutes(app);
  await registerKnowledgeRoutes(app);
  await registerOfflineRoutes(app);
  await registerLocalLlmRoutes(app);
  await registerTtsRoutes(app);
  await registerLocalVlmRoutes(app);
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Bridge 运行于 http://${config.host}:${config.port}`);
  void runLocalLlmStartupMaintenance();
  void initializeResourceSchedulerOnBridgeStart().catch((error: unknown) => {
    app.log.warn({ err: error }, "资源调度器初始化失败");
  });
  void maybeWarmLocalLlmOnBridgeStart();
  const shutdown = async (): Promise<void> => {
    const { releaseOfflineStack } = await import("./services/resource-scheduler.js");
    await releaseOfflineStack();
    await releasePilotTtsLane();
    await stopManagedLocalLlm();
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}


main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
