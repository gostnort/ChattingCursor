import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { registerTtsRoutes } from "./tts.js";
import { writeSchedulerUserSettings } from "../services/scheduler-settings.js";


function seedPilotTtsWeights(tempRoot: string, options?: { instruct?: boolean }): string {
  const weights = join(tempRoot, "pretrained_models");
  mkdirSync(join(weights, "w2v-bert-2.0"), { recursive: true });
  writeFileSync(join(weights, "pilot_tts.pt"), "x", "utf8");
  if (options?.instruct) {
    writeFileSync(join(weights, "pilot_tts_instruct.pt"), "x", "utf8");
  }
  writeFileSync(join(weights, "w2v-bert-2.0", "config.json"), "{}", "utf8");
  return weights;
}


test("POST /tts/synthesize 合并默认并代理完整 JSON", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "tts-synth-merge-"));
  const previousHome = process.env.CHATTINGCURSOR_HOME;
  const previousWeights = process.env.PILOT_TTS_WEIGHTS_DIR;
  const originalFetch = globalThis.fetch;
  let synthesizeBody = "";
  try {
    const weights = seedPilotTtsWeights(tempRoot, { instruct: true });
    process.env.CHATTINGCURSOR_HOME = tempRoot;
    process.env.PILOT_TTS_WEIGHTS_DIR = weights;
    await writeSchedulerUserSettings({
      pilotTtsPromptWavPath: "C:\\voice\\saved.wav",
      pilotTtsDefaultEmotion: "happy",
      pilotTtsDefaultLanguage: "zh-henan",
    });
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ weightsReady: true, gpuLoaded: true }), { status: 200 });
      }
      if (url.includes("/synthesize") && init?.method === "POST") {
        synthesizeBody = String(init.body ?? "");
        return new Response(Buffer.from("RIFF"), {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        });
      }
      return originalFetch(input, init);
    };
    const app = Fastify({ logger: false });
    await registerTtsRoutes(app);
    const response = await app.inject({
      method: "POST",
      url: "/tts/synthesize",
      payload: { text: "hello" },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(synthesizeBody), {
      text: "hello",
      promptWav: "C:\\voice\\saved.wav",
      emotion: "happy",
      language: "zh-henan",
    });
    await app.close();
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) {
      delete process.env.CHATTINGCURSOR_HOME;
    } else {
      process.env.CHATTINGCURSOR_HOME = previousHome;
    }
    if (previousWeights === undefined) {
      delete process.env.PILOT_TTS_WEIGHTS_DIR;
    } else {
      process.env.PILOT_TTS_WEIGHTS_DIR = previousWeights;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});


test("POST /tts/synthesize per-request 覆盖默认", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "tts-synth-override-"));
  const previousHome = process.env.CHATTINGCURSOR_HOME;
  const previousWeights = process.env.PILOT_TTS_WEIGHTS_DIR;
  const originalFetch = globalThis.fetch;
  let synthesizeBody = "";
  try {
    const weights = seedPilotTtsWeights(tempRoot, { instruct: true });
    process.env.CHATTINGCURSOR_HOME = tempRoot;
    process.env.PILOT_TTS_WEIGHTS_DIR = weights;
    await writeSchedulerUserSettings({
      pilotTtsPromptWavPath: "C:\\voice\\saved.wav",
      pilotTtsDefaultEmotion: "happy",
      pilotTtsDefaultLanguage: "zh-henan",
    });
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ weightsReady: true, gpuLoaded: true }), { status: 200 });
      }
      if (url.includes("/synthesize") && init?.method === "POST") {
        synthesizeBody = String(init.body ?? "");
        return new Response(Buffer.from("RIFF"), {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        });
      }
      return originalFetch(input, init);
    };
    const app = Fastify({ logger: false });
    await registerTtsRoutes(app);
    const response = await app.inject({
      method: "POST",
      url: "/tts/synthesize",
      payload: {
        text: "hello",
        promptWav: "D:\\voice\\override.mp3",
        emotion: "neutral",
        language: "",
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(synthesizeBody), {
      text: "hello",
      promptWav: "D:\\voice\\override.mp3",
      emotion: "neutral",
    });
    await app.close();
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) {
      delete process.env.CHATTINGCURSOR_HOME;
    } else {
      process.env.CHATTINGCURSOR_HOME = previousHome;
    }
    if (previousWeights === undefined) {
      delete process.env.PILOT_TTS_WEIGHTS_DIR;
    } else {
      process.env.PILOT_TTS_WEIGHTS_DIR = previousWeights;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});


test("POST /tts/synthesize 缺 instruct 权重且含 emotion 时返回 503", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "tts-synth-instruct-"));
  const previousHome = process.env.CHATTINGCURSOR_HOME;
  const previousWeights = process.env.PILOT_TTS_WEIGHTS_DIR;
  const originalFetch = globalThis.fetch;
  let synthesizeCalls = 0;
  try {
    const weights = seedPilotTtsWeights(tempRoot);
    process.env.CHATTINGCURSOR_HOME = tempRoot;
    process.env.PILOT_TTS_WEIGHTS_DIR = weights;
    await writeSchedulerUserSettings({ pilotTtsDefaultEmotion: "happy" });
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ weightsReady: true, gpuLoaded: true }), { status: 200 });
      }
      if (url.includes("/synthesize")) {
        synthesizeCalls += 1;
      }
      return originalFetch(input, init);
    };
    const app = Fastify({ logger: false });
    await registerTtsRoutes(app);
    const response = await app.inject({
      method: "POST",
      url: "/tts/synthesize",
      payload: { text: "hello" },
    });
    assert.equal(response.statusCode, 503);
    const body = response.json() as { error?: string; message?: string };
    assert.equal(body.error, "instruct_weights_missing");
    assert.match(body.message ?? "", /Instruct model weights/i);
    assert.equal(synthesizeCalls, 0);
    await app.close();
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) {
      delete process.env.CHATTINGCURSOR_HOME;
    } else {
      process.env.CHATTINGCURSOR_HOME = previousHome;
    }
    if (previousWeights === undefined) {
      delete process.env.PILOT_TTS_WEIGHTS_DIR;
    } else {
      process.env.PILOT_TTS_WEIGHTS_DIR = previousWeights;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
