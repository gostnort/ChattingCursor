import type { FastifyInstance } from "fastify";
import {
  ensurePilotTtsSidecarStarted,
  ensurePilotTtsWebuiStarted,
  stopPilotTtsWebui,
  getPilotTtsLaneStatus,
  releasePilotTtsLane,
  isPilotTtsInstallPresent,
  isPilotTtsGpuWarming,
  isPilotTtsSidecarActive,
  isPilotTtsUpstreamInstalled,
  isPilotTtsWebuiActive,
  probePilotTtsHealth,
  resolvePilotTtsInstallPhase,
  resolvePilotTtsBaseUrl,
  resolvePilotTtsPort,
  resolvePilotTtsWebuiPort,
  resolvePilotTtsWebuiUrl,
  startPilotTtsService,
} from "../services/pilot-tts-lifecycle.js";
import {
  getPilotTtsInstallSnapshot,
  isPilotTtsUpstreamPresent,
  isPilotTtsWeightsReady,
} from "../services/pilot-tts-paths.js";
import { getPilotTtsInstallJob, startPilotTtsInstall } from "../services/pilot-tts-install.js";
import { mapPilotWebuiError, probePilotTtsWebui } from "../services/pilot-tts-webui-spawn.js";
import {
  getResourceSchedulerSnapshot,
  isResourceSchedulerBlocked,
} from "../services/resource-scheduler.js";


/** PilotTTS：安装、4323 API、8090 WebUI（测试/调试） */
export async function registerTtsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tts/capability", async (_request, reply) => {
    const snapshot = getResourceSchedulerSnapshot();
    const health = await probePilotTtsHealth();
    const lane = getPilotTtsLaneStatus();
    const pilotSynthAvailable = health.ok
      && health.weightsReady
      && health.gpuLoaded
      && lane === "ready"
      && isPilotTtsSidecarActive();
    return reply.send({
      pilotTtsEnabled: snapshot.pilotTts.enabled,
      pilotLaneStatus: lane,
      pilotSynthAvailable,
      browserFallback: true,
      schedulerBlocked: isResourceSchedulerBlocked(),
      blockReason: snapshot.blockReason,
      reservedVramGb: snapshot.pilotTts.reservedVramGb,
      message: pilotSynthAvailable
        ? "可使用 PilotTTS 合成"
        : "将回退浏览器朗读（Pilot 未就绪或合成未实现）",
    });
  });


  app.get("/tts/status", async (_request, reply) => {
    const health = await probePilotTtsHealth();
    const webui = await probePilotTtsWebui();
    const snapshot = getPilotTtsInstallSnapshot();
    const upstreamInstalled = health.upstreamPresent || snapshot.upstreamPresent;
    const weightsReady = health.weightsReady || snapshot.weightsReady;
    const sidecarResponding = health.ok;
    const installPhase = resolvePilotTtsInstallPhase({
      sidecarPresent: snapshot.sidecarPresent,
      upstreamPresent: upstreamInstalled,
      weightsReady,
      gpuLoaded: health.gpuLoaded,
    });
    return reply.send({
      pilotStatus: getPilotTtsLaneStatus(),
      installPhase,
      ports: {
        bridgeApi: 4323,
        pilotWebUi: resolvePilotTtsWebuiPort(),
        offlineLlm: 4322,
        offlineVlm: 4325,
        note: "4323=ChattingCursor 朗读 API；8090=官方 Gradio 配置/试听（webui.py）",
      },
      apiPort: resolvePilotTtsPort(),
      baseUrl: resolvePilotTtsBaseUrl(),
      webUiUrl: resolvePilotTtsWebuiUrl(),
      webUiActive: isPilotTtsWebuiActive() || webui.ok,
      installPresent: snapshot.sidecarPresent,
      upstreamInstalled,
      upstreamDir: snapshot.upstreamDir,
      sidecarActive: sidecarResponding,
      gpuLoaded: health.gpuLoaded,
      gpuWarming: isPilotTtsGpuWarming(),
      loadError: health.loadError,
      weightsReady,
      needsRepair: !upstreamInstalled || !weightsReady,
      healthMessage: sidecarResponding
        ? (health.gpuLoaded ? health.message : (health.loadError ?? health.message))
        : health.message,
    });
  });


  app.post("/tts/install", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { reset?: boolean };
      const jobId = startPilotTtsInstall(body.reset);
      return reply.send({ jobId });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(409).send({ error: "install_busy", message });
    }
  });


  app.post("/tts/repair", async (_request, reply) => {
    try {
      const jobId = startPilotTtsInstall();
      return reply.send({ jobId, message: "已启动 PilotTTS 修复安装（补全上游与权重）。" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(409).send({ error: "install_busy", message });
    }
  });


  app.get("/tts/install/:jobId", async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const job = getPilotTtsInstallJob(jobId);
    if (!job) {
      return reply.status(404).send({ error: "not_found", message: "安装任务不存在" });
    }
    return reply.send(job);
  });


  app.post("/tts/stop", async (_request, reply) => {
    await releasePilotTtsLane();
    return reply.send({ ok: true });
  });


  app.post("/tts/start", async (_request, reply) => {
    if (!isPilotTtsInstallPresent()) {
      return reply.status(404).send({
        error: "not_installed",
        message: "尚未安装 PilotTTS，请先在语音页点击「安装 PilotTTS」。",
      });
    }
    try {
      const result = await startPilotTtsService();
      const payload = {
        ok: result.ok,
        warming: result.warming === true,
        pilotStatus: result.pilotStatus,
        weightsReady: result.weightsReady,
        gpuLoaded: result.gpuLoaded,
        upstreamInstalled: isPilotTtsUpstreamInstalled(),
        message: result.message,
        apiUrl: resolvePilotTtsBaseUrl(),
      };
      if (!result.ok) {
        return reply.status(503).send({ error: "start_failed", ...payload });
      }
      return reply.send(payload);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(503).send({ error: "start_failed", message });
    }
  });


  app.post("/tts/webui/start", async (_request, reply) => {
    if (!isPilotTtsUpstreamInstalled() && !isPilotTtsUpstreamPresent()) {
      return reply.status(404).send({
        error: "upstream_missing",
        ok: false,
        message: "未安装 PilotTTS 上游。请先在语音页点击「安装 PilotTTS」。",
      });
    }
    try {
      await ensurePilotTtsWebuiStarted();
      const webui = await probePilotTtsWebui();
      if (!webui.ok) {
        return reply.status(503).send({
          error: "webui_start_failed",
          ok: false,
          webUiUrl: webui.url,
          message: "配置界面启动后仍未响应，请稍后重试或查看安装日志。",
        });
      }
      return reply.send({
        ok: true,
        webUiUrl: webui.url,
        message: "配置界面已就绪",
      });
    } catch (error: unknown) {
      const message = mapPilotWebuiError(error);
      return reply.status(503).send({ error: "webui_start_failed", ok: false, message });
    }
  });


  app.post("/tts/webui/stop", async (_request, reply) => {
    try {
      await stopPilotTtsWebui();
      return reply.send({ ok: true, message: "配置界面已关闭" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: "webui_stop_failed", ok: false, message });
    }
  });


  app.post("/tts/synthesize", async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string };
    const text = body.text?.trim() ?? "";
    if (!text) {
      return reply.status(400).send({ error: "invalid_request", message: "text 不能为空" });
    }
    if (!isPilotTtsWeightsReady()) {
      return reply.status(503).send({
        error: "weights_missing",
        message: "PilotTTS 权重未安装。请运行 pilot_tts/install.bat 下载 AmapVoice/PilotTTS。",
        fallback: true,
      });
    }
    try {
      await ensurePilotTtsSidecarStarted();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(503).send({
        error: "pilot_unavailable",
        message: `PilotTTS API(4323) 未启动：${message}`,
        fallback: true,
      });
    }
    const health = await probePilotTtsHealth();
    if (!health.ok) {
      return reply.status(503).send({
        error: "pilot_unavailable",
        message: health.message ?? "PilotTTS sidecar 无响应",
        fallback: true,
      });
    }
    const response = await fetch(`${resolvePilotTtsBaseUrl()}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (response.ok && (response.headers.get("content-type") ?? "").includes("audio")) {
      const buffer = Buffer.from(await response.arrayBuffer());
      reply.header("Content-Type", response.headers.get("content-type") ?? "audio/wav");
      return reply.send(buffer);
    }
    const payload = await response.json().catch(() => ({})) as { message?: string; fallback?: boolean };
    return reply.status(response.status).send({
      error: "synthesize_failed",
      message: payload.message ?? "PilotTTS 合成失败，请使用浏览器朗读或在 8090 WebUI 试听。",
      fallback: payload.fallback ?? true,
    });
  });
}
