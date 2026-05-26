import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import {
  getChattingCursorHomeDir,
  getDefaultTokenSyncDir,
  getUserConfigPath,
} from "../paths.js";


export interface UserConfigFile {
  tokenSyncDir?: string;
}


/** 同步读取用户配置（启动时解析目录用） */
export function readUserConfigSync(): UserConfigFile {
  const configPath = getUserConfigPath();
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as UserConfigFile;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}


/** 解析 token 同步目录：环境变量 > 持久化配置 > 默认 ~/.chattingcursor */
export function resolveTokenSyncDirectory(): string {
  const fromEnv = process.env.CHATTINGCURSOR_TOKEN_SYNC_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromFile = readUserConfigSync().tokenSyncDir?.trim();
  if (fromFile) {
    return fromFile;
  }
  return getDefaultTokenSyncDir();
}


/** 持久化用户选择的 token 同步目录 */
export async function saveTokenSyncDirectory(directory: string): Promise<void> {
  const normalized = directory.trim();
  if (!normalized) {
    throw new Error("同步目录不能为空");
  }
  const home = getChattingCursorHomeDir();
  await mkdir(home, { recursive: true });
  const existing = readUserConfigSync();
  const next: UserConfigFile = {
    ...existing,
    tokenSyncDir: normalized,
  };
  await writeFile(getUserConfigPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
