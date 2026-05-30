import assert from "node:assert/strict";
import test from "node:test";
import {
  completeGemma4ChatViaHfInference,
  isGemma4HfInferenceEnabled,
  isGemma4HfInferenceFallbackEnabled,
  resolveGemma4HfInferenceChatUrl,
  resolveHfToken,
} from "./gemma4-client.js";


test("HF Inference 开关与默认 URL", () => {
  const prevUse = process.env.GEMMA4_USE_HF_INFERENCE;
  const prevFallback = process.env.GEMMA4_HF_INFERENCE_FALLBACK;
  const prevUrl = process.env.GEMMA4_HF_INFERENCE_URL;
  delete process.env.GEMMA4_USE_HF_INFERENCE;
  delete process.env.GEMMA4_HF_INFERENCE_FALLBACK;
  delete process.env.GEMMA4_HF_INFERENCE_URL;
  assert.equal(isGemma4HfInferenceEnabled(), false);
  assert.equal(isGemma4HfInferenceFallbackEnabled(), false);
  assert.equal(
    resolveGemma4HfInferenceChatUrl(),
    "https://router.huggingface.co/v1/chat/completions",
  );
  process.env.GEMMA4_USE_HF_INFERENCE = "1";
  assert.equal(isGemma4HfInferenceEnabled(), true);
  process.env.GEMMA4_HF_INFERENCE_FALLBACK = "true";
  assert.equal(isGemma4HfInferenceFallbackEnabled(), true);
  process.env.GEMMA4_HF_INFERENCE_URL = "https://example.test/v1/chat/completions";
  assert.equal(resolveGemma4HfInferenceChatUrl(), "https://example.test/v1/chat/completions");
  process.env.GEMMA4_USE_HF_INFERENCE = prevUse ?? "";
  process.env.GEMMA4_HF_INFERENCE_FALLBACK = prevFallback ?? "";
  process.env.GEMMA4_HF_INFERENCE_URL = prevUrl ?? "";
});


test("resolveHfToken 读取 HF_TOKEN 或 HUGGINGFACE_HUB_TOKEN", () => {
  const prev = process.env.HF_TOKEN;
  const prevHub = process.env.HUGGINGFACE_HUB_TOKEN;
  delete process.env.HF_TOKEN;
  delete process.env.HUGGINGFACE_HUB_TOKEN;
  assert.equal(resolveHfToken(), "");
  process.env.HF_TOKEN = "hf_test";
  assert.equal(resolveHfToken(), "hf_test");
  delete process.env.HF_TOKEN;
  process.env.HUGGINGFACE_HUB_TOKEN = "hf_hub";
  assert.equal(resolveHfToken(), "hf_hub");
  process.env.HF_TOKEN = prev ?? "";
  process.env.HUGGINGFACE_HUB_TOKEN = prevHub ?? "";
});


test("completeGemma4ChatViaHfInference 无 token 时报错", async () => {
  const prev = process.env.HF_TOKEN;
  delete process.env.HF_TOKEN;
  delete process.env.HUGGINGFACE_HUB_TOKEN;
  await assert.rejects(
    () => completeGemma4ChatViaHfInference([{ role: "user", content: "hi" }]),
    /HF Inference 需要/,
  );
  process.env.HF_TOKEN = prev ?? "";
});
