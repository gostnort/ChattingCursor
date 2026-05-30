import assert from "node:assert/strict";
import test from "node:test";
import { isLocalLlmModelId, resolveOfflineRuntimeId } from "@chatting-cursor/shared";
import { buildLocalLlmModelId } from "./local-llm-store.js";
import { getOfflineModelSnapshot } from "./offline-runtime.js";


test("resolveOfflineRuntimeId 映射 local-llm 模型", () => {
  const modelId = buildLocalLlmModelId("unsloth", "gemma-4-E4B-it-GGUF");
  assert.equal(isLocalLlmModelId(modelId), true);
  assert.equal(resolveOfflineRuntimeId(modelId), "local-llm");
});


test("getOfflineModelSnapshot 返回 local-llm runtime", async () => {
  const modelId = buildLocalLlmModelId("unsloth", "gemma-4-E4B-it-GGUF");
  const snapshot = await getOfflineModelSnapshot(modelId);
  assert.equal(snapshot.modelId, modelId);
  assert.equal(snapshot.runtime, "local-llm");
});
