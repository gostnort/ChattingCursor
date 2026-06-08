import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { registerTtsRoutes } from "./tts.js";


test("POST /tts/start 无 pilot_tts 时返回 404", async () => {
  const previous = process.env.PILOT_TTS_SERVER_SCRIPT;
  process.env.PILOT_TTS_SERVER_SCRIPT = join(tmpdir(), "missing-pilot-tts-server.py");
  const app = Fastify({ logger: false });
  try {
    await registerTtsRoutes(app);
    const response = await app.inject({
      method: "POST",
      url: "/tts/start",
    });
    assert.equal(response.statusCode, 404);
  } finally {
    if (previous === undefined) {
      delete process.env.PILOT_TTS_SERVER_SCRIPT;
    } else {
      process.env.PILOT_TTS_SERVER_SCRIPT = previous;
    }
    await app.close();
  }
});


test("GET /tts/status 返回 installPresent 与 installPhase 字段", async () => {
  const app = Fastify({ logger: false });
  await registerTtsRoutes(app);
  const response = await app.inject({
    method: "GET",
    url: "/tts/status",
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    installPresent?: boolean;
    installPhase?: string;
    needsRepair?: boolean;
    baseUrl?: string;
    gpuLoaded?: boolean;
    gpuWarming?: boolean;
    sidecarActive?: boolean;
    upstreamInstalled?: boolean;
  };
  assert.equal(typeof body.installPresent, "boolean");
  assert.equal(typeof body.installPhase, "string");
  assert.equal(typeof body.needsRepair, "boolean");
  assert.equal(typeof body.upstreamInstalled, "boolean");
  assert.ok(body.baseUrl?.includes("4323"));
  assert.equal(typeof body.gpuLoaded, "boolean");
  assert.equal(typeof body.gpuWarming, "boolean");
  assert.equal(typeof body.sidecarActive, "boolean");
  await app.close();
});


test("POST /tts/repair 启动安装任务", async () => {
  const app = Fastify({ logger: false });
  await registerTtsRoutes(app);
  const response = await app.inject({
    method: "POST",
    url: "/tts/repair",
  });
  assert.ok(response.statusCode === 200 || response.statusCode === 409);
  if (response.statusCode === 200) {
    const body = response.json() as { jobId?: string };
    assert.ok(body.jobId?.startsWith("pilot-install-"));
  }
  await app.close();
});


test("POST /tts/webui/start 无 upstream 时返回 404 与中文说明", async () => {
  const previousUpstream = process.env.PILOT_TTS_UPSTREAM_DIR;
  const previousRoot = process.env.PILOT_TTS_ROOT;
  const previousScript = process.env.PILOT_TTS_SERVER_SCRIPT;
  const missingRoot = join(tmpdir(), "missing-pilot-upstream-root");
  process.env.PILOT_TTS_ROOT = missingRoot;
  process.env.PILOT_TTS_UPSTREAM_DIR = join(missingRoot, "upstream");
  process.env.PILOT_TTS_SERVER_SCRIPT = join(missingRoot, "server", "tts_server.py");
  const app = Fastify({ logger: false });
  try {
    await registerTtsRoutes(app);
    const response = await app.inject({
      method: "POST",
      url: "/tts/webui/start",
    });
    assert.equal(response.statusCode, 404);
    const body = response.json() as { message?: string; ok?: boolean };
    assert.match(body.message ?? "", /安装 PilotTTS/);
    assert.equal(body.ok, false);
  } finally {
    if (previousUpstream === undefined) {
      delete process.env.PILOT_TTS_UPSTREAM_DIR;
    } else {
      process.env.PILOT_TTS_UPSTREAM_DIR = previousUpstream;
    }
    if (previousRoot === undefined) {
      delete process.env.PILOT_TTS_ROOT;
    } else {
      process.env.PILOT_TTS_ROOT = previousRoot;
    }
    if (previousScript === undefined) {
      delete process.env.PILOT_TTS_SERVER_SCRIPT;
    } else {
      process.env.PILOT_TTS_SERVER_SCRIPT = previousScript;
    }
    await app.close();
  }
});
