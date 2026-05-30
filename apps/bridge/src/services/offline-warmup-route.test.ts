import assert from "node:assert/strict";
import test from "node:test";
import { offlineWarmupRequestSchema } from "@chatting-cursor/shared";
import { buildLocalLlmModelId } from "./local-llm-store.js";


test("offlineWarmupRequestSchema 接受 local-llm modelId", () => {
  const modelId = buildLocalLlmModelId("unsloth", "gemma-4-E4B-it-GGUF");
  const request = offlineWarmupRequestSchema.parse({ modelId });
  assert.equal(request.modelId, modelId);
  const snapshot = {
    modelId,
    runtime: "local-llm",
    ready: false,
    spawning: false,
    running: false,
  };
  assert.equal(snapshot.runtime, "local-llm");
});
