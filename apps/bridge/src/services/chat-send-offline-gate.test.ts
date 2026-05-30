import assert from "node:assert/strict";
import test from "node:test";
import { isLocalLlmModelId, resolveOfflineRuntimeId } from "@chatting-cursor/shared";
import { buildLocalLlmModelId } from "./local-llm-store.js";
import { isLocalLlmModel } from "./local-llm-client.js";


function chatSendNeedsCursorCli(_prompt: string, model?: string): boolean {
  const useLocal = isLocalLlmModel(model);
  return !useLocal;
}


test("local-llm 模型 id 识别", () => {
  const id = buildLocalLlmModelId("unsloth", "gemma-4-E4B-it-GGUF");
  assert.equal(isLocalLlmModelId(id), true);
  assert.equal(resolveOfflineRuntimeId(id), "local-llm");
  assert.equal(chatSendNeedsCursorCli("你好", id), false);
});
