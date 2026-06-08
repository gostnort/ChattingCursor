import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Fastify from "fastify";
import { registerChatRoutes } from "./chat.js";
import { registerLocalLlmRoutes } from "./local-llm.js";
import { registerOfflineRoutes } from "./offline.js";
import { registerTtsRoutes } from "./tts.js";


const bridgeSrcDir = join(dirname(fileURLToPath(import.meta.url)), "..");


function readBridgeSource(relativePath: string): string {
  return readFileSync(join(bridgeSrcDir, relativePath), "utf8");
}


test("〇-B：chat 路由不依赖 resource-scheduler", () => {
  const source = readBridgeSource("routes/chat.ts");
  assert.doesNotMatch(source, /resource-scheduler/);
  assert.doesNotMatch(source, /assertOfflineSchedulerAllows/);
});


test("〇-B：在线看图服务不依赖 resource-scheduler", () => {
  const source = readBridgeSource("services/image-analysis-service.ts");
  assert.doesNotMatch(source, /resource-scheduler/);
  assert.doesNotMatch(source, /assertOfflineSchedulerAllows/);
});


test("〇-B：TTS 路由不依赖 chat 路由", () => {
  const source = readBridgeSource("routes/tts.ts");
  assert.doesNotMatch(source, /routes\/chat/);
  assert.doesNotMatch(source, /scheduleCursorCliRun/);
  assert.doesNotMatch(source, /registerChatRoutes/);
});


test("〇-B：POST /tts/synthesize 不触及 CLI 对话", () => {
  const source = readBridgeSource("routes/tts.ts");
  const start = source.indexOf('app.post("/tts/synthesize"');
  assert.ok(start >= 0);
  const block = source.slice(start, start + 2500);
  assert.doesNotMatch(block, /scheduleCursorCliRun/);
  assert.doesNotMatch(block, /runCursorCli/);
  assert.doesNotMatch(block, /sessionStore/);
});


test("〇-B：scheduleCursorCliRun 块内无离线调度门禁", () => {
  const source = readBridgeSource("routes/chat.ts");
  const start = source.indexOf("function scheduleCursorCliRun");
  assert.ok(start >= 0);
  const end = source.indexOf("function finishCancelledRun", start);
  assert.ok(end > start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /assertOfflineSchedulerAllows/);
  assert.doesNotMatch(block, /releaseOfflineStack/);
  assert.doesNotMatch(block, /ensureLocalLlmSidecarStarted/);
});


test("〇-B：upload-image 在线分支在离线 return 之后才调用 analyzeUploadedImage", () => {
  const source = readBridgeSource("routes/chat.ts");
  const handlerStart = source.indexOf('app.post("/chat/upload-image"');
  assert.ok(handlerStart >= 0);
  const handlerSlice = source.slice(handlerStart, handlerStart + 6000);
  const offlineReturn = handlerSlice.indexOf("scheduleLocalLlmRun");
  const sdkAnalyze = handlerSlice.indexOf("analyzeUploadedImage");
  assert.ok(offlineReturn >= 0);
  assert.ok(sdkAnalyze >= 0);
  assert.ok(sdkAnalyze > offlineReturn, "在线 SDK 看图应在离线路径之后");
});


test("GET /tts/capability 返回 Pilot 能力与浏览器回退", async () => {
  const app = Fastify({ logger: false });
  await registerTtsRoutes(app);
  const response = await app.inject({ method: "GET", url: "/tts/capability" });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    pilotTtsEnabled: boolean;
    pilotSynthAvailable: boolean;
    browserFallback: boolean;
    pilotLaneStatus: string;
  };
  assert.equal(body.browserFallback, true);
  assert.equal(typeof body.pilotTtsEnabled, "boolean");
  assert.equal(typeof body.pilotSynthAvailable, "boolean");
  assert.ok(typeof body.pilotLaneStatus === "string");
  await app.close();
});


test("POST /offline/release-stack 走 releaseOfflineStack", async () => {
  const app = Fastify({ logger: false });
  await registerOfflineRoutes(app);
  const response = await app.inject({
    method: "POST",
    url: "/offline/release-stack",
    remoteAddress: "127.0.0.1",
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    ok: boolean;
    llmUnloaded: boolean;
    vlmUnloaded: boolean;
  };
  assert.equal(body.ok, true);
  assert.equal(typeof body.llmUnloaded, "boolean");
  assert.equal(typeof body.vlmUnloaded, "boolean");
  await app.close();
});


test("POST /local-llm/stop 走 releaseOfflineStack 并返回 llm/vlm 字段", async () => {
  const app = Fastify({ logger: false });
  await registerLocalLlmRoutes(app);
  const response = await app.inject({
    method: "POST",
    url: "/local-llm/stop",
    remoteAddress: "127.0.0.1",
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    ok: boolean;
    llmUnloaded: boolean;
    vlmUnloaded: boolean;
  };
  assert.equal(body.ok, true);
  assert.equal(typeof body.llmUnloaded, "boolean");
  assert.equal(typeof body.vlmUnloaded, "boolean");
  await app.close();
});


test("POST /chat/send 在线模型路径注册成功（不经离线调度断言）", async () => {
  const app = Fastify({ logger: false });
  await registerChatRoutes(app);
  const response = await app.inject({
    method: "POST",
    url: "/chat/send",
    payload: {
      sessionId: "scope-0b-session",
      prompt: "hello",
      model: "gpt-4",
    },
  });
  assert.ok(response.statusCode === 200 || response.statusCode === 503);
  await app.close();
});
