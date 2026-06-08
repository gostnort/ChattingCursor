import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { getChattingCursorHomeDir } from "../paths.js";
import { DEFAULT_OFFLINE_VLM_REPO } from "./local-vlm-store.js";


export type OfflineVisionSettings = {
  enabled: boolean;
  selectedModelId: string | null;
  defaultRepoId: string;
};


const SETTINGS_FILE = "offline-vision-settings.json";


function settingsPath(): string {
  return path.join(getChattingCursorHomeDir(), SETTINGS_FILE);
}


/** 读取离线视觉配置（默认启用） */
export async function readOfflineVisionSettings(): Promise<OfflineVisionSettings> {
  const file = settingsPath();
  if (!existsSync(file)) {
    return {
      enabled: true,
      selectedModelId: null,
      defaultRepoId: DEFAULT_OFFLINE_VLM_REPO,
    };
  }
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<OfflineVisionSettings>;
    return {
      enabled: parsed.enabled !== false,
      selectedModelId: typeof parsed.selectedModelId === "string" ? parsed.selectedModelId : null,
      defaultRepoId: parsed.defaultRepoId?.trim() || DEFAULT_OFFLINE_VLM_REPO,
    };
  } catch {
    return {
      enabled: true,
      selectedModelId: null,
      defaultRepoId: DEFAULT_OFFLINE_VLM_REPO,
    };
  }
}


/** 更新离线视觉配置 */
export async function writeOfflineVisionSettings(
  patch: Partial<Pick<OfflineVisionSettings, "enabled" | "selectedModelId" | "defaultRepoId">>,
): Promise<OfflineVisionSettings> {
  const current = await readOfflineVisionSettings();
  const next: OfflineVisionSettings = {
    ...current,
    enabled: patch.enabled ?? current.enabled,
    selectedModelId: patch.selectedModelId === undefined
      ? current.selectedModelId
      : patch.selectedModelId,
    defaultRepoId: patch.defaultRepoId?.trim() || current.defaultRepoId,
  };
  await mkdir(getChattingCursorHomeDir(), { recursive: true });
  await writeFile(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
