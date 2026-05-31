import { accessSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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


function pathExistsAsDirectory(candidate: string): boolean {
  try {
    accessSync(candidate);
    return true;
  } catch {
    return false;
  }
}


/** 将 onedrive: 远程路径与 ~ 展开为本机目录（与 scripts/sh/resolve-token-sync-dir.sh 对齐） */
export function normalizeTokenSyncDirectory(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("同步目录不能为空");
  }
  if (/^onedrive:/i.test(trimmed)) {
    let rel = trimmed.replace(/^onedrive:/i, "").replace(/^\/+/, "");
    if (/^onedrive\//i.test(rel)) {
      rel = rel.replace(/^onedrive\//i, "").replace(/^OneDrive\//i, "");
    }
    const expanded = rel.startsWith("~")
      ? path.join(os.homedir(), rel.slice(1).replace(/^\/+/, ""))
      : rel.startsWith("/")
        ? rel
        : path.join(os.homedir(), rel);
    const candidates = [
      expanded,
      path.join(os.homedir(), "OneDrive", rel),
      path.join(os.homedir(), "onedrive", rel),
      path.join(os.homedir(), "OneDrive - Personal", rel),
    ];
    for (const candidate of candidates) {
      if (pathExistsAsDirectory(candidate)) {
        return candidate;
      }
    }
    if (/^OneDrive[/\\]/i.test(rel) || /^onedrive[/\\]/i.test(rel)) {
      return path.join(os.homedir(), rel);
    }
    return path.join(os.homedir(), "OneDrive", rel);
  }
  if (trimmed.startsWith("~")) {
    return path.join(os.homedir(), trimmed.slice(1).replace(/^[/\\]+/, ""));
  }
  return trimmed;
}


/** 解析 token 同步目录：环境变量 > 持久化配置 > 默认 ~/.chattingcursor */
export function resolveTokenSyncDirectory(): string {
  const fromEnv = process.env.CHATTINGCURSOR_TOKEN_SYNC_DIR?.trim();
  if (fromEnv) {
    return normalizeTokenSyncDirectory(fromEnv);
  }
  const fromFile = readUserConfigSync().tokenSyncDir?.trim();
  if (fromFile) {
    return normalizeTokenSyncDirectory(fromFile);
  }
  return getDefaultTokenSyncDir();
}


/** 持久化用户选择的 token 同步目录 */
export async function saveTokenSyncDirectory(directory: string): Promise<void> {
  const normalized = normalizeTokenSyncDirectory(directory);
  const home = getChattingCursorHomeDir();
  await mkdir(home, { recursive: true });
  const existing = readUserConfigSync();
  const next: UserConfigFile = {
    ...existing,
    tokenSyncDir: normalized,
  };
  await writeFile(getUserConfigPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
