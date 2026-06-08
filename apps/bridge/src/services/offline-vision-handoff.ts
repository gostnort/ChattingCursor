import { buildImageForwardPrompt } from "./image-analysis-service.js";
import { embedOfflineImage, ensureOfflineVlmReady, isOfflineVlmEnabled } from "./offline-vlm-client.js";
import type { SessionMessage } from "./session-store.js";


/** 由 embedding 向量生成给主 LLM 的简短文本摘要 */
export function summarizeEmbeddingVector(vector: number[], userIntent?: string): string {
  const dim = vector.length;
  const head = vector.slice(0, 8).map((value) => value.toFixed(4)).join(", ");
  const intent = userIntent?.trim() || "请结合图片内容回答用户问题。";
  return [
    "【离线视觉摘要】已用 Qwen3-VL-Embedding 处理附件图片（仅文本交接，无结构化标注）。",
    `向量维度：${dim}；前几维：${head}${dim > 8 ? "…" : ""}`,
    `用户意图：${intent}`,
    "请根据上述视觉编码与用户对话上下文作答；若信息不足请明确说明。",
  ].join("\n");
}


/** 离线图片 → VLM embedding → 可注入主 LLM 的 handoff 文本 */
export async function buildOfflineVisionHandoffText(options: {
  offlineLlmModelId: string;
  imageDataUrl: string;
  fileName: string;
  messages: SessionMessage[];
  userIntent?: string;
  signal?: AbortSignal;
}): Promise<string> {
  await ensureOfflineVlmReady(options.offlineLlmModelId);
  const instruction = options.userIntent?.trim()
    || "Describe the image for downstream text-only LLM.";
  const vector = await embedOfflineImage(options.imageDataUrl, instruction, options.signal);
  const analysisText = summarizeEmbeddingVector(vector, options.userIntent);
  return buildImageForwardPrompt(analysisText, options.fileName, options.messages, options.userIntent);
}


/** 是否应对离线路径走 VLM 文本交接（主 LLM 无原生 vision） */
export async function shouldUseOfflineVisionHandoff(hasImage: boolean, modelId?: string): Promise<boolean> {
  if (!hasImage) {
    return false;
  }
  if (modelId) {
    const lower = modelId.toLowerCase();
    if (lower.includes("-vl") || lower.includes("vision") || lower.includes("llava") || lower.includes("minicpm-v")) {
      return false;
    }
  }
  return await isOfflineVlmEnabled();
}
