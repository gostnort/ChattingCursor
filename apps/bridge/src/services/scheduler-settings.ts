import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { getChattingCursorHomeDir } from "../paths.js";
import { DEFAULT_OFFLINE_VLM_REPO } from "./local-vlm-store.js";
import { writeOfflineVisionSettings, readOfflineVisionSettings } from "./offline-vision-settings.js";


export type SchedulerUserSettings = {
  /** 车道 1：是否预留 PilotTTS 显存（配置页） */
  pilotTtsEnabled: boolean;
  /** 用户勾选「启用朗读 API」：会话内自动启动 4323 与 GPU 预热 */
  pilotTtsApiEnabled: boolean;
  pilotTtsReservedVramGb: number;
  defaultOfflineVlmRepo: string;
  offlineVlmEnabled: boolean;
};


const SETTINGS_FILE = "scheduler-settings.json";
const DEFAULT_RESERVED_GB = 3;


function settingsPath(): string {
  return path.join(getChattingCursorHomeDir(), SETTINGS_FILE);
}


/** 读取三路调度用户配置 */
export async function readSchedulerUserSettings(): Promise<SchedulerUserSettings> {
  const vision = await readOfflineVisionSettings();
  if (!existsSync(settingsPath())) {
    return {
      pilotTtsEnabled: true,
      pilotTtsApiEnabled: false,
      pilotTtsReservedVramGb: DEFAULT_RESERVED_GB,
      defaultOfflineVlmRepo: vision.defaultRepoId || DEFAULT_OFFLINE_VLM_REPO,
      offlineVlmEnabled: vision.enabled,
    };
  }
  try {
    const raw = await readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<SchedulerUserSettings>;
    const reserved = Number(parsed.pilotTtsReservedVramGb);
    return {
      pilotTtsEnabled: parsed.pilotTtsEnabled !== false,
      pilotTtsApiEnabled: parsed.pilotTtsApiEnabled === true,
      pilotTtsReservedVramGb: Number.isFinite(reserved) && reserved > 0 ? reserved : DEFAULT_RESERVED_GB,
      defaultOfflineVlmRepo: parsed.defaultOfflineVlmRepo?.trim() || DEFAULT_OFFLINE_VLM_REPO,
      offlineVlmEnabled: parsed.offlineVlmEnabled !== false,
    };
  } catch {
    return {
      pilotTtsEnabled: true,
      pilotTtsApiEnabled: false,
      pilotTtsReservedVramGb: DEFAULT_RESERVED_GB,
      defaultOfflineVlmRepo: DEFAULT_OFFLINE_VLM_REPO,
      offlineVlmEnabled: vision.enabled,
    };
  }
}


/** 更新三路调度用户配置（同步 offlineVlm 到视觉设置） */
export async function writeSchedulerUserSettings(
  patch: Partial<SchedulerUserSettings>,
): Promise<SchedulerUserSettings> {
  const current = await readSchedulerUserSettings();
  const next: SchedulerUserSettings = {
    pilotTtsEnabled: patch.pilotTtsEnabled ?? current.pilotTtsEnabled,
    pilotTtsApiEnabled: patch.pilotTtsApiEnabled ?? current.pilotTtsApiEnabled,
    pilotTtsReservedVramGb: patch.pilotTtsReservedVramGb ?? current.pilotTtsReservedVramGb,
    defaultOfflineVlmRepo: patch.defaultOfflineVlmRepo?.trim() || current.defaultOfflineVlmRepo,
    offlineVlmEnabled: patch.offlineVlmEnabled ?? current.offlineVlmEnabled,
  };
  await mkdir(getChattingCursorHomeDir(), { recursive: true });
  await writeFile(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  if (
    patch.offlineVlmEnabled !== undefined
    || patch.defaultOfflineVlmRepo !== undefined
  ) {
    await writeOfflineVisionSettings({
      enabled: next.offlineVlmEnabled,
      defaultRepoId: next.defaultOfflineVlmRepo,
    });
  }
  return next;
}
