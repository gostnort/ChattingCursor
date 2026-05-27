import path from "node:path";
import os from "node:os";


/** 用户数据根目录（与历史记录同级） */
export function getChattingCursorHomeDir(): string {
  return path.join(os.homedir(), ".chattingcursor");
}


/** 默认 token 同步目录：与 history 同属 ~/.chattingcursor */
export function getDefaultTokenSyncDir(): string {
  return getChattingCursorHomeDir();
}


/** 旧版默认 token 目录（仅用于一次性迁移） */
export function getLegacyTokenSyncDir(): string {
  return path.join(os.homedir(), "ChattingCursorTokenSync");
}


/** 用户配置文件路径 */
export function getUserConfigPath(): string {
  return path.join(getChattingCursorHomeDir(), "config.json");
}


/** 命名 Cloudflare 隧道配置（本机 only） */
export function getCloudflareTunnelConfigPath(): string {
  return path.join(getChattingCursorHomeDir(), "cloudflare-tunnel.json");
}


/** 默认历史目录 */
export function getDefaultHistoryDir(): string {
  return path.join(getChattingCursorHomeDir(), "history");
}


/** 聊天图片上传目录 */
export function getUploadsDir(): string {
  return path.join(getChattingCursorHomeDir(), "uploads");
}


/** /websearch 分页与去重状态（测试可通过 CHATTINGCURSOR_WEBSEARCH_STATE_PATH 覆盖） */
export function getWebSearchStatePath(): string {
  const override = process.env.CHATTINGCURSOR_WEBSEARCH_STATE_PATH?.trim();
  if (override) {
    return override;
  }
  return path.join(getChattingCursorHomeDir(), "websearch-state.json");
}
