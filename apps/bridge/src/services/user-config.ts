import { accessSync } from "node:fs";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
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


export type TokenSyncDirectorySource = "default" | "env" | "config";


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


function expandUserPath(raw: string): string {
  if (raw.startsWith("~")) {
    return path.join(os.homedir(), raw.slice(1).replace(/^[/\\]+/, ""));
  }
  return raw;
}


/** 常见 OneDrive 本机路径与 rclone 挂载点候选 */
function onedriveLocalCandidates(rel: string): string[] {
  const home = os.homedir();
  const expanded = rel.startsWith("/") ? rel : path.join(home, rel);
  return [
    expanded,
    path.join(home, "OneDrive", rel),
    path.join(home, "onedrive", rel),
    path.join(home, "OneDrive - Personal", rel),
    path.join(home, "mnt", "onedrive", rel),
    path.join(home, "rclone", "onedrive", rel),
    path.join(home, ".OneDrive", rel),
    path.join("/mnt", "onedrive", rel),
  ];
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
    const expandedRel = expandUserPath(rel);
    if (expandedRel.startsWith("/") && pathExistsAsDirectory(expandedRel)) {
      return expandedRel;
    }
    if (expandedRel.startsWith("/") && !pathExistsAsDirectory(expandedRel)) {
      throw new Error(
        `onedrive: 路径在本机不存在或不可访问: ${expandedRel}（请确认 OneDrive/rclone 已同步或挂载）`,
      );
    }
    for (const candidate of onedriveLocalCandidates(rel)) {
      if (pathExistsAsDirectory(candidate)) {
        return candidate;
      }
    }
    throw new Error(
      `无法将 onedrive: 解析到本机目录（${trimmed}）。请改用已存在的本机路径，例如 ~/OneDrive/... 或 rclone 挂载点。`,
    );
  }
  if (trimmed.startsWith("~")) {
    return expandUserPath(trimmed);
  }
  return trimmed;
}


/** 解析 token 目录配置来源 */
export function getTokenSyncDirectorySource(): TokenSyncDirectorySource {
  const fromEnv = process.env.CHATTINGCURSOR_TOKEN_SYNC_DIR?.trim();
  if (fromEnv) {
    return "env";
  }
  const fromFile = readUserConfigSync().tokenSyncDir?.trim();
  if (fromFile) {
    return "config";
  }
  return "default";
}


/** 是否为用户显式指定的同步目录（非默认 ~/.chattingcursor） */
export function isUserSpecifiedTokenSyncDirectory(source?: TokenSyncDirectorySource): boolean {
  return (source ?? getTokenSyncDirectorySource()) !== "default";
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


/** 校验用户指定目录：存在、为目录、可写（不写则抛错） */
export async function validateTokenSyncDirectory(directory: string): Promise<void> {
  let info;
  try {
    info = await stat(directory);
  } catch {
    throw new Error(
      `Token 同步目录不存在: ${directory}（用户指定的云目录须先在本机存在，不会自动创建）`,
    );
  }
  if (!info.isDirectory()) {
    throw new Error(`Token 同步路径不是目录: ${directory}`);
  }
  const probe = path.join(directory, `.chattingcursor-write-test-${process.pid}`);
  try {
    await writeFile(probe, "", "utf8");
    await unlink(probe);
  } catch {
    throw new Error(
      `Token 同步目录不可写: ${directory}（请确认 OneDrive/rclone 已挂载且该文件夹有写权限）`,
    );
  }
}


/** 默认目录可创建；用户指定目录仅校验 */
export async function ensureTokenSyncDirectoryReady(
  directory: string,
  options?: { userSpecified?: boolean },
): Promise<void> {
  const userSpecified = options?.userSpecified ?? isUserSpecifiedTokenSyncDirectory();
  const isDefaultPath = path.resolve(directory) === path.resolve(getDefaultTokenSyncDir());
  if (!userSpecified || isDefaultPath) {
    await mkdir(directory, { recursive: true });
    return;
  }
  await validateTokenSyncDirectory(directory);
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
