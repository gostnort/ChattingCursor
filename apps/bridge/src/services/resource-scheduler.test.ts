import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  computeOfflineLlmNGpuLayers,
  getAllocationState,
  getResourceSchedulerSnapshot,
  planOfflineLlmLoad,
  planStartup,
  probeGpu,
  releaseOfflineStack,
} from "./resource-scheduler.js";
import { setPilotTtsReservedVramGb } from "./pilot-tts-lifecycle.js";


test("probeGpu 为 probeGpuVram 别名", () => {
  const probe = probeGpu();
  assert.equal(typeof probe.available, "boolean");
});


test("getAllocationState 与 getResourceSchedulerSnapshot 一致", () => {
  assert.deepEqual(getAllocationState(), getResourceSchedulerSnapshot());
});


test("computeOfflineLlmNGpuLayers 显存充足时倾向全 GPU", () => {
  const layers = computeOfflineLlmNGpuLayers(2, 4);
  assert.equal(layers, -1);
});


test("computeOfflineLlmNGpuLayers 无显存信息时回退 CPU", () => {
  const layers = computeOfflineLlmNGpuLayers(8, null);
  assert.equal(layers, 0);
});


test("planStartup 禁用 Pilot 时不阻塞离线", async () => {
  const plan = await planStartup({ pilotTtsEnabled: false });
  assert.equal(plan.ok, true);
  const snapshot = getResourceSchedulerSnapshot();
  assert.equal(snapshot.blocked, false);
});


test("planStartup Pilot 未安装/未就绪时默认不阻塞离线", async () => {
  const previousScript = process.env.PILOT_TTS_SERVER_SCRIPT;
  const previousAllow = process.env.PILOT_TTS_ALLOW_OFFLINE_WITHOUT_PILOT;
  const previousEnabled = process.env.PILOT_TTS_ENABLED;
  process.env.PILOT_TTS_SERVER_SCRIPT = join(tmpdir(), "missing-pilot-tts-server.py");
  delete process.env.PILOT_TTS_ALLOW_OFFLINE_WITHOUT_PILOT;
  process.env.PILOT_TTS_ENABLED = "1";
  try {
    const plan = await planStartup({ pilotTtsEnabled: true });
    const snapshot = getResourceSchedulerSnapshot();
    assert.equal(snapshot.blocked, false);
    assert.equal(plan.ok, true);
    assert.ok(
      plan.pilotLane === "skipped"
      || plan.pilotLane === "failed"
      || plan.pilotLane === "degraded"
      || plan.pilotLane === "idle",
    );
  } finally {
    if (previousScript === undefined) {
      delete process.env.PILOT_TTS_SERVER_SCRIPT;
    } else {
      process.env.PILOT_TTS_SERVER_SCRIPT = previousScript;
    }
    if (previousAllow === undefined) {
      delete process.env.PILOT_TTS_ALLOW_OFFLINE_WITHOUT_PILOT;
    } else {
      process.env.PILOT_TTS_ALLOW_OFFLINE_WITHOUT_PILOT = previousAllow;
    }
    if (previousEnabled === undefined) {
      delete process.env.PILOT_TTS_ENABLED;
    } else {
      process.env.PILOT_TTS_ENABLED = previousEnabled;
    }
    await planStartup({ pilotTtsEnabled: false });
    await releaseOfflineStack();
  }
});


test("planOfflineLlmLoad 写入调度快照", async () => {
  const previousPilot = process.env.PILOT_TTS_ENABLED;
  process.env.PILOT_TTS_ENABLED = "0";
  try {
    await planStartup({ pilotTtsEnabled: false });
    planOfflineLlmLoad("test-model", 1.2);
    const snapshot = getResourceSchedulerSnapshot();
    assert.equal(snapshot.offlineLlm.modelId, "test-model");
    assert.ok(snapshot.offlineLlm.nGpuLayers !== null);
  } finally {
    if (previousPilot === undefined) {
      delete process.env.PILOT_TTS_ENABLED;
    } else {
      process.env.PILOT_TTS_ENABLED = previousPilot;
    }
    await releaseOfflineStack();
  }
});


test("显存不足时 planStartup 阻塞且 planOfflineLlmLoad 抛出", async () => {
  const previousAllow = process.env.PILOT_TTS_ALLOW_OFFLINE_WITHOUT_PILOT;
  setPilotTtsReservedVramGb(99999);
  process.env.PILOT_TTS_ALLOW_OFFLINE_WITHOUT_PILOT = "0";
  try {
    const plan = await planStartup({ pilotTtsEnabled: true });
    const gpu = getResourceSchedulerSnapshot().gpu;
    if (gpu.available && gpu.freeVramGb !== null && gpu.freeVramGb < 99999) {
      assert.equal(plan.ok, false);
      assert.throws(
        () => planOfflineLlmLoad("blocked-model", 2),
        /资源调度|显存|PilotTTS|朗读/,
      );
    }
  } finally {
    setPilotTtsReservedVramGb(3);
    if (previousAllow === undefined) {
      delete process.env.PILOT_TTS_ALLOW_OFFLINE_WITHOUT_PILOT;
    } else {
      process.env.PILOT_TTS_ALLOW_OFFLINE_WITHOUT_PILOT = previousAllow;
    }
    await planStartup({ pilotTtsEnabled: false });
    await releaseOfflineStack();
  }
});
