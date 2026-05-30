/** 本地 LLM 模型 id 前缀：local-llm/{author}/{model_slug} */
export const LOCAL_LLM_MODEL_ID_PREFIX = "local-llm/";


/** 当前内置的离线模型列表（动态模型由 Bridge /models 注入） */
export const OFFLINE_MODEL_IDS = [] as const;


export type OfflineModelId = string;


/** 判断是否为 local-llm 模型 id */
export function isLocalLlmModelId(modelId: string | undefined): modelId is string {
  if (!modelId) {
    return false;
  }
  return modelId.startsWith(LOCAL_LLM_MODEL_ID_PREFIX);
}


/** 判断是否为离线模型 */
export function isOfflineModelId(modelId: string | undefined): modelId is string {
  return isLocalLlmModelId(modelId);
}


/** 离线模型展示信息（静态占位，实际由 registry 扫描） */
export const OFFLINE_MODEL_OPTIONS: Array<{ id: string; label: string }> = [];


/** 本地推理运行时 */
export type OfflineRuntimeId = "local-llm";


/** 将离线模型 id 映射到 Bridge 侧运行时 */
export function resolveOfflineRuntimeId(modelId: string): OfflineRuntimeId | null {
  if (isLocalLlmModelId(modelId)) {
    return "local-llm";
  }
  return null;
}


/** @deprecated 使用 isLocalLlmModelId */
export const GEMMA4_OFFLINE_MODEL_ID = "local-llm/unsloth/gemma-4-E4B-it-GGUF";
