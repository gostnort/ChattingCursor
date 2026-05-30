import type { ModelInfo } from "@chatting-cursor/shared";
import { isOfflineModelId } from "@chatting-cursor/shared";


export const OFFLINE_RESET_NOTICE = "已切换为 Auto，离线模型需手动选择";


/** 重连后优先 Auto，否则默认在线模型 */
export function pickDefaultOnlineModelId(models: ModelInfo[], aliasMap: Map<string, string>): string {
  const autoModel = models.find((item) => item.id === "auto" && item.kind !== "offline");
  if (autoModel) {
    return aliasMap.get(autoModel.id) ?? autoModel.id;
  }
  const defaultOnline = models.find((item) => item.isDefault && item.kind !== "offline")
    ?? models.find((item) => item.kind !== "offline")
    ?? models.find((item) => !isOfflineModelId(item.id));
  const id = defaultOnline?.id ?? models[0]?.id ?? "";
  return aliasMap.get(id) ?? id;
}


/** 重连时解析模型：离线模型重置为 Auto/默认在线模型 */
export function resolveModelOnReconnect(
  storedModelId: string,
  models: ModelInfo[],
  aliasMap: Map<string, string>,
): { modelId: string; resetFromOffline: boolean } {
  if (isOfflineModelId(storedModelId)) {
    return { modelId: pickDefaultOnlineModelId(models, aliasMap), resetFromOffline: true };
  }
  if (storedModelId && models.some((item) => item.id === storedModelId)) {
    return { modelId: aliasMap.get(storedModelId) ?? storedModelId, resetFromOffline: false };
  }
  return { modelId: pickDefaultOnlineModelId(models, aliasMap), resetFromOffline: false };
}
