/** 调度器与 lifecycle 共享的状态，避免循环依赖 */


let llmNGpuLayersOverride: number | null = null;
let activeOfflineLlmModelId: string | null = null;
let vlmBoundModelId: string | null = null;
let vlmLoaded = false;


export function setLlmNGpuLayersOverride(layers: number | null): void {
  llmNGpuLayersOverride = layers;
}


export function resolveScheduledLlmNGpuLayersEnv(): string | undefined {
  if (llmNGpuLayersOverride === null) {
    return undefined;
  }
  return String(llmNGpuLayersOverride);
}


export function setActiveOfflineLlmModelId(modelId: string | null): void {
  activeOfflineLlmModelId = modelId;
}


export function getActiveOfflineLlmModelIdState(): string | null {
  return activeOfflineLlmModelId;
}


export function getLlmNGpuLayersOverride(): number | null {
  return llmNGpuLayersOverride;
}


export function markOfflineVlmLoadedState(modelId: string): void {
  vlmBoundModelId = modelId;
  vlmLoaded = true;
}


export function clearOfflineVlmBindingState(): void {
  vlmBoundModelId = null;
  vlmLoaded = false;
}


export function isOfflineVlmLoadedForModelState(modelId: string): boolean {
  return vlmLoaded && vlmBoundModelId === modelId;
}


export function getOfflineVlmBindingState(): { boundModelId: string | null; loaded: boolean } {
  return { boundModelId: vlmBoundModelId, loaded: vlmLoaded };
}
