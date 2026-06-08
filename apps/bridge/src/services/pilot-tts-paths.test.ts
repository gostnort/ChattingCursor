import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getPilotTtsUpstreamDir,
  isPilotTtsInstructWeightsPresent,
  isPilotTtsUpstreamPresent,
  isPilotTtsWeightsReady,
  resolvePilotTtsInstallPhase,
} from "./pilot-tts-paths.js";


test("resolvePilotTtsInstallPhase 区分未装、缺上游、缺权重与就绪", () => {
  assert.equal(
    resolvePilotTtsInstallPhase({
      sidecarPresent: false,
      upstreamPresent: false,
      weightsReady: false,
      gpuLoaded: false,
    }),
    "missing",
  );
  assert.equal(
    resolvePilotTtsInstallPhase({
      sidecarPresent: true,
      upstreamPresent: false,
      weightsReady: true,
      gpuLoaded: false,
    }),
    "partial",
  );
  assert.equal(
    resolvePilotTtsInstallPhase({
      sidecarPresent: true,
      upstreamPresent: true,
      weightsReady: false,
      gpuLoaded: false,
    }),
    "needs_weights",
  );
  assert.equal(
    resolvePilotTtsInstallPhase({
      sidecarPresent: true,
      upstreamPresent: true,
      weightsReady: true,
      gpuLoaded: false,
    }),
    "ready_no_gpu",
  );
  assert.equal(
    resolvePilotTtsInstallPhase({
      sidecarPresent: true,
      upstreamPresent: true,
      weightsReady: true,
      gpuLoaded: true,
    }),
    "ready",
  );
});


test("手动 install.bat 后能从 sidecar 旁路检测到 upstream/webui.py", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pilot-paths-"));
  const previousRepo = process.env.CHATTINGCURSOR_REPO_ROOT;
  const previousScript = process.env.PILOT_TTS_SERVER_SCRIPT;
  const previousUpstream = process.env.PILOT_TTS_UPSTREAM_DIR;
  const previousRoot = process.env.PILOT_TTS_ROOT;
  try {
    const pilotRoot = join(tempRoot, "wrong-repo", "pilot_tts");
    const sidecar = join(pilotRoot, "server", "tts_server.py");
    const upstream = join(pilotRoot, "upstream");
    mkdirSync(join(pilotRoot, "server"), { recursive: true });
    mkdirSync(join(upstream, "pretrained_models"), { recursive: true });
    writeFileSync(sidecar, "# sidecar\n", "utf8");
    writeFileSync(join(upstream, "webui.py"), "# webui\n", "utf8");
    mkdirSync(join(upstream, "pretrained_models", "w2v-bert-2.0"), { recursive: true });
    writeFileSync(join(upstream, "pretrained_models", "pilot_tts.pt"), "x", "utf8");
    writeFileSync(
      join(upstream, "pretrained_models", "w2v-bert-2.0", "config.json"),
      "{}",
      "utf8",
    );
    process.env.CHATTINGCURSOR_REPO_ROOT = join(tempRoot, "wrong-repo");
    process.env.PILOT_TTS_SERVER_SCRIPT = sidecar;
    delete process.env.PILOT_TTS_UPSTREAM_DIR;
    delete process.env.PILOT_TTS_ROOT;
    assert.equal(isPilotTtsUpstreamPresent(), true);
    assert.equal(isPilotTtsWeightsReady(), true);
    assert.match(getPilotTtsUpstreamDir(), /upstream$/);
  } finally {
    if (previousRepo === undefined) {
      delete process.env.CHATTINGCURSOR_REPO_ROOT;
    } else {
      process.env.CHATTINGCURSOR_REPO_ROOT = previousRepo;
    }
    if (previousScript === undefined) {
      delete process.env.PILOT_TTS_SERVER_SCRIPT;
    } else {
      process.env.PILOT_TTS_SERVER_SCRIPT = previousScript;
    }
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
    rmSync(tempRoot, { recursive: true, force: true });
  }
});


test("isPilotTtsInstructWeightsPresent 检测 instruct 检查点", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pilot-instruct-"));
  const previousWeights = process.env.PILOT_TTS_WEIGHTS_DIR;
  try {
    const weights = join(tempRoot, "pretrained_models");
    mkdirSync(weights, { recursive: true });
    writeFileSync(join(weights, "pilot_tts.pt"), "x", "utf8");
    process.env.PILOT_TTS_WEIGHTS_DIR = weights;
    assert.equal(isPilotTtsInstructWeightsPresent(), false);
    writeFileSync(join(weights, "pilot_tts_instruct.pt"), "x", "utf8");
    assert.equal(isPilotTtsInstructWeightsPresent(), true);
  } finally {
    if (previousWeights === undefined) {
      delete process.env.PILOT_TTS_WEIGHTS_DIR;
    } else {
      process.env.PILOT_TTS_WEIGHTS_DIR = previousWeights;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});


test("isPilotTtsWeightsReady 在仅有检查点但缺少 w2v-bert 时返回 false", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pilot-w2v-"));
  const previousWeights = process.env.PILOT_TTS_WEIGHTS_DIR;
  try {
    const weights = join(tempRoot, "pretrained_models");
    mkdirSync(weights, { recursive: true });
    writeFileSync(join(weights, "pilot_tts.pt"), "x", "utf8");
    process.env.PILOT_TTS_WEIGHTS_DIR = weights;
    assert.equal(isPilotTtsWeightsReady(), false);
    mkdirSync(join(weights, "w2v-bert-2.0"), { recursive: true });
    writeFileSync(join(weights, "w2v-bert-2.0", "config.json"), "{}", "utf8");
    assert.equal(isPilotTtsWeightsReady(), true);
  } finally {
    if (previousWeights === undefined) {
      delete process.env.PILOT_TTS_WEIGHTS_DIR;
    } else {
      process.env.PILOT_TTS_WEIGHTS_DIR = previousWeights;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
