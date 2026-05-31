import assert from "node:assert/strict";
import test from "node:test";
import { formatLocalLlmError } from "@chatting-cursor/shared";


/** 模拟 scheduleLocalLlmRun 失败路径的消息格式化 */
function formatOfflineInferenceFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const formatted = formatLocalLlmError(message);
  return formatted.startsWith("本地模型") ? formatted : `本地模型推理失败：${formatted}`;
}


test("离线推理失败消息包含中文修复建议", () => {
  const text = formatOfflineInferenceFailure(new Error("connect ECONNREFUSED 127.0.0.1:4322"));
  assert.match(text, /4322|sidecar/i);
  assert.match(text, /Bridge|llm_server/i);
});


test("ensureLocalLlmReady 类错误映射显存不足", () => {
  const text = formatLocalLlmError("GGUF 文件约 26.0 GB，远超 GPU 显存 12.0 GB。请改用 Q4_K_M");
  assert.match(text, /Q4_K_M|显存|26/i);
});
