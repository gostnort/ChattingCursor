import { readFile } from "node:fs/promises";
import { formatLocalLlmError, isOfflineModelId } from "@chatting-cursor/shared";
import { ensureLocalLlmReady, resolveLocalLlmApiBaseUrl } from "./local-llm-lifecycle.js";
import { findInstalledLocalLlmModel, resolveHfToken } from "./local-llm-store.js";
import { buildKnowledgeContext } from "./knowledge-store.js";
import type { SessionMessage } from "./session-store.js";


interface OpenAiMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}


/** 是否强制使用 Hugging Face Inference API */
export function isLocalLlmHfInferenceEnabled(): boolean {
  const flag = process.env.LOCAL_LLM_USE_HF_INFERENCE?.trim()
    ?? process.env.GEMMA4_USE_HF_INFERENCE?.trim()
    ?? "";
  return flag === "1" || flag.toLowerCase() === "true";
}


export const isGemma4HfInferenceEnabled = isLocalLlmHfInferenceEnabled;


/** 本地加载失败时是否回退到 HF Inference API */
export function isLocalLlmHfInferenceFallbackEnabled(): boolean {
  const flag = process.env.LOCAL_LLM_HF_INFERENCE_FALLBACK?.trim()
    ?? process.env.GEMMA4_HF_INFERENCE_FALLBACK?.trim()
    ?? "";
  return flag === "1" || flag.toLowerCase() === "true";
}


export const isGemma4HfInferenceFallbackEnabled = isLocalLlmHfInferenceFallbackEnabled;


/** HF Inference OpenAI 兼容 chat/completions 地址 */
export function resolveLocalLlmHfInferenceChatUrl(): string {
  const custom = process.env.LOCAL_LLM_HF_INFERENCE_URL?.trim()
    ?? process.env.GEMMA4_HF_INFERENCE_URL?.trim();
  if (custom) {
    return custom.replace(/\/$/, "");
  }
  return "https://router.huggingface.co/v1/chat/completions";
}


export const resolveGemma4HfInferenceChatUrl = resolveLocalLlmHfInferenceChatUrl;


async function resolveImageUrl(imageUrl: string, bridgeOrigin: string): Promise<string | null> {
  if (imageUrl.startsWith("data:")) {
    return imageUrl;
  }
  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
    return imageUrl;
  }
  if (imageUrl.startsWith("/")) {
    try {
      const absolute = new URL(imageUrl, bridgeOrigin);
      const response = await fetch(absolute.toString());
      if (!response.ok) {
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const mime = response.headers.get("content-type") || "image/png";
      return `data:${mime};base64,${buffer.toString("base64")}`;
    } catch {
      return null;
    }
  }
  return null;
}


export async function imageFileToDataUrl(absolutePath: string, mimeType: string): Promise<string> {
  const buffer = await readFile(absolutePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}


/** 组装多轮消息（含可选图片与模型 defaultPrompt） */
export async function buildLocalLlmMessages(options: {
  prompt: string;
  history: SessionMessage[];
  imageDataUrl?: string;
  bridgeOrigin: string;
  modelId: string;
}): Promise<OpenAiMessage[]> {
  const model = await findInstalledLocalLlmModel(options.modelId);
  const knowledge = await buildKnowledgeContext();
  const systemParts = [
    model?.defaultPrompt?.trim()
      || "You are a helpful assistant running locally for ChattingCursor. Answer clearly and helpfully.",
    knowledge ? `\n${knowledge}` : "",
  ].filter(Boolean);
  const messages: OpenAiMessage[] = [
    { role: "system", content: systemParts.join("\n") },
  ];
  const recent = options.history.slice(-20);
  for (const item of recent) {
    if (item.role !== "user" && item.role !== "assistant") {
      continue;
    }
    const text = item.content.trim();
    if (!text) {
      continue;
    }
    if (item.role === "user" && item.imageUrl) {
      const resolved = await resolveImageUrl(item.imageUrl, options.bridgeOrigin);
      if (resolved) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text },
            { type: "image_url", image_url: { url: resolved } },
          ],
        });
        continue;
      }
    }
    messages.push({ role: item.role, content: text });
  }
  if (options.imageDataUrl) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: options.prompt },
        { type: "image_url", image_url: { url: options.imageDataUrl } },
      ],
    });
    return messages;
  }
  const last = recent[recent.length - 1];
  if (last?.role === "user" && last.content.trim() === options.prompt.trim()) {
    return messages;
  }
  messages.push({ role: "user", content: options.prompt });
  return messages;
}


export const buildGemma4Messages = buildLocalLlmMessages;


function extractChatCompletionText(payload: {
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
}): string {
  const choice = payload.choices?.[0]?.message?.content;
  if (typeof choice === "string") {
    return choice.trim();
  }
  if (Array.isArray(choice)) {
    return choice.map((part) => part.text ?? "").join("").trim();
  }
  return "";
}


async function completeLocalLlmChatLocal(
  modelId: string,
  messages: OpenAiMessage[],
  signal?: AbortSignal,
): Promise<string> {
  try {
    await ensureLocalLlmReady(modelId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(formatLocalLlmError(message));
  }
  const baseUrl = resolveLocalLlmApiBaseUrl();
  const apiKey = process.env.LOCAL_LLM_API_KEY?.trim() || process.env.GEMMA4_API_KEY?.trim() || "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const chatTimeoutMs = Number(
    process.env.LOCAL_LLM_CHAT_TIMEOUT_MS ?? process.env.GEMMA4_CHAT_TIMEOUT_MS ?? 600_000,
  );
  const timeoutSignal = AbortSignal.timeout(chatTimeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelId,
      messages,
      max_tokens: Number(process.env.LOCAL_LLM_MAX_TOKENS ?? process.env.GEMMA4_MAX_TOKENS ?? 2048),
    }),
    signal: combinedSignal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(formatLocalLlmError(`本地 LLM API ${response.status}: ${body.slice(0, 500)}`));
  }
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };
  const text = extractChatCompletionText(payload);
  if (!text) {
    throw new Error("本地 LLM API 返回无内容");
  }
  return text;
}


export async function completeLocalLlmChatViaHfInference(
  modelId: string,
  messages: OpenAiMessage[],
): Promise<string> {
  const token = resolveHfToken();
  if (!token) {
    throw new Error("HF Inference 需要环境变量 HF_TOKEN（或 HUGGINGFACE_HUB_TOKEN）");
  }
  const model = await findInstalledLocalLlmModel(modelId);
  const hfModelId = model?.repoId ?? modelId;
  const chatTimeoutMs = Number(
    process.env.LOCAL_LLM_HF_CHAT_TIMEOUT_MS
      ?? process.env.GEMMA4_HF_CHAT_TIMEOUT_MS
      ?? process.env.GEMMA4_CHAT_TIMEOUT_MS
      ?? 600_000,
  );
  const response = await fetch(resolveLocalLlmHfInferenceChatUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: hfModelId,
      messages,
      max_tokens: Number(process.env.LOCAL_LLM_MAX_TOKENS ?? process.env.GEMMA4_MAX_TOKENS ?? 2048),
    }),
    signal: AbortSignal.timeout(chatTimeoutMs),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HF Inference ${response.status}: ${body.slice(0, 500)}`);
  }
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };
  const text = extractChatCompletionText(payload);
  if (!text) {
    throw new Error("HF Inference 返回无内容");
  }
  return text;
}


export const completeGemma4ChatViaHfInference = async (messages: OpenAiMessage[]): Promise<string> => {
  const { listInstalledLocalLlmModels } = await import("./local-llm-store.js");
  const models = await listInstalledLocalLlmModels();
  const modelId = models[0]?.id ?? "local-llm";
  return completeLocalLlmChatViaHfInference(modelId, messages);
};


/** 调用本地 LLM（默认 sidecar；可选 HF Inference 或失败回退） */
export async function completeLocalLlmChat(
  modelId: string,
  messages: OpenAiMessage[],
  signal?: AbortSignal,
): Promise<string> {
  if (isLocalLlmHfInferenceEnabled()) {
    return completeLocalLlmChatViaHfInference(modelId, messages);
  }
  try {
    return await completeLocalLlmChatLocal(modelId, messages, signal);
  } catch (localError) {
    if (signal?.aborted) {
      throw localError;
    }
    if (!isLocalLlmHfInferenceFallbackEnabled() || !resolveHfToken()) {
      throw localError;
    }
    const detail = localError instanceof Error ? localError.message : String(localError);
    console.warn(`[local-llm] 本地推理失败，回退 HF Inference: ${detail}`);
    return completeLocalLlmChatViaHfInference(modelId, messages);
  }
}


export async function completeGemma4Chat(messages: OpenAiMessage[]): Promise<string> {
  const { listInstalledLocalLlmModels } = await import("./local-llm-store.js");
  const models = await listInstalledLocalLlmModels();
  const modelId = models[0]?.id;
  if (!modelId) {
    throw new Error("未找到已安装的本地模型");
  }
  return completeLocalLlmChat(modelId, messages);
}


/** 当前请求是否应由本地离线运行时处理 */
export function isLocalLlmModel(modelId: string | undefined): boolean {
  return isOfflineModelId(modelId);
}


export const isGemma4Model = isLocalLlmModel;
