import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";


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


/** /websearch 抓取结果缓存目录（测试可通过 CHATTINGCURSOR_WEBSEARCH_CACHE_DIR 覆盖） */
export function getWebSearchCacheDir(): string {
  const override = process.env.CHATTINGCURSOR_WEBSEARCH_CACHE_DIR?.trim();
  if (override) {
    return override;
  }
  return path.join(getChattingCursorHomeDir(), "web-search-cache");
}


/** 仓库根目录（用于 Knowledge/、local_llm/ 推理代码与权重） */
export function getRepoRootDir(): string {
  const override = process.env.CHATTINGCURSOR_REPO_ROOT?.trim();
  if (override) {
    return override;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..");
}


/** local_llm 根目录（已安装模型与 registry.json） */
export function getLocalLlmRootDir(): string {
  const override = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR?.trim()
    ?? process.env.CHATTINGCURSOR_GEMMA4_DIR?.trim();
  if (override) {
    return override;
  }
  return path.join(getRepoRootDir(), "local_llm");
}


/** HF 下载临时缓存（全仓库统一目录；权重仍落在 author/model_slug，任务结束即清空） */
export function getLocalLlmHfDownloadCacheDir(): string {
  return path.join(getLocalLlmRootDir(), ".hf-download-cache");
}


/** 单次安装任务的 HF 暂存目录（避免 --local-dir 在 model 目录内产生 .cache） */
export function getLocalLlmHfDownloadStagingDir(jobId: string): string {
  const safe = jobId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(getLocalLlmHfDownloadCacheDir(), "staging", safe);
}


/** 本地模型安装任务持久化目录（不在 local_llm/ 作者扫描路径内） */
export function getLocalLlmInstallJobsDir(): string {
  const override = process.env.CHATTINGCURSOR_LOCAL_LLM_INSTALL_JOBS_DIR?.trim();
  if (override) {
    return override;
  }
  return path.join(getRepoRootDir(), ".chattingcursor", "local-llm-install-jobs");
}


/** local_llm sidecar 脚本路径 */
export function getLocalLlmServerScriptPath(): string {
  const override = process.env.LOCAL_LLM_SERVER_SCRIPT?.trim()
    ?? process.env.GEMMA4_SERVER_SCRIPT?.trim();
  if (override) {
    return override;
  }
  return path.join(getRepoRootDir(), "local_llm", "server", "llm_server.py");
}


/** 知识库 wiki 根目录 */
export function getKnowledgeDir(): string {
  const override = process.env.CHATTINGCURSOR_KNOWLEDGE_DIR?.trim();
  if (override) {
    return override;
  }
  return path.join(getRepoRootDir(), "Knowledge");
}


/** @deprecated 使用 getLocalLlmRootDir */
export function getGemma4ModelDir(): string {
  return getLocalLlmRootDir();
}


/** @deprecated 使用 getLocalLlmServerScriptPath */
export function getGemma4ServerScriptPath(): string {
  return getLocalLlmServerScriptPath();
}
