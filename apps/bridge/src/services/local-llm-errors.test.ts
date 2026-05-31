import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyLocalLlmError,
  formatLocalLlmError,
  formatOfflineLoadStatus,
} from "@chatting-cursor/shared";


test("classifyLocalLlmError 识别显存不足", () => {
  assert.equal(
    classifyLocalLlmError("GGUF 文件约 26.0 GB，远超 GPU 显存 12.0 GB"),
    "vram_insufficient",
  );
});


test("classifyLocalLlmError 识别权重缺失", () => {
  assert.equal(
    classifyLocalLlmError("未在 /tmp/weights 找到 *.gguf 权重"),
    "weights_missing",
  );
});


test("classifyLocalLlmError 识别 CUDA 缺失", () => {
  assert.equal(
    classifyLocalLlmError("Could not load library libcublas.so.12"),
    "cuda_missing",
  );
});


test("classifyLocalLlmError 识别 sidecar 未运行", () => {
  assert.equal(
    classifyLocalLlmError("推理 sidecar 未运行，无法加载模型"),
    "sidecar_down",
  );
  assert.equal(
    classifyLocalLlmError("connect ECONNREFUSED 127.0.0.1:4322"),
    "sidecar_down",
  );
});


test("classifyLocalLlmError 识别加载超时", () => {
  assert.equal(
    classifyLocalLlmError("模型加载超时（600 秒）"),
    "load_timeout",
  );
});


test("formatLocalLlmError 保留已是中文且含建议的消息", () => {
  const raw = "系统可用内存约 8.0 GB，加载 model.gguf 可能内存不足。请关闭其他程序或改用更小量化。";
  assert.equal(formatLocalLlmError(raw), raw);
});


test("formatLocalLlmError 为英文 CUDA 错误补充中文说明", () => {
  const formatted = formatLocalLlmError("Failed to load CUDA library");
  assert.match(formatted, /CUDA/);
  assert.match(formatted, /LOCAL_LLM_N_GPU_LAYERS=0/);
});


test("formatOfflineLoadStatus 就绪与错误状态行", () => {
  assert.equal(
    formatOfflineLoadStatus({ phase: "ready", message: "加载完成" }),
    "加载完成",
  );
  assert.match(
    formatOfflineLoadStatus({ phase: "error", error: "connection refused 4322" }) ?? "",
    /4322|sidecar/i,
  );
});
