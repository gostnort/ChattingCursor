import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getLocalLlmInstallJobsDir, getLocalLlmRootDir } from "../paths.js";


export type InstallJobPhase = "queued" | "resolving" | "downloading" | "finalizing" | "done" | "error";


export type InstallJobStatus = {
  jobId: string;
  state: "running" | "done" | "error";
  progress: string;
  phase?: InstallJobPhase;
  totalBytes?: number | null;
  downloadedBytes?: number;
  percent?: number | null;
  error?: string;
  model?: Record<string, unknown>;
};


const LEGACY_INSTALL_JOBS_DIR = ".install-jobs";
const installJobs = new Map<string, InstallJobStatus>();
const activeJobIds = new Set<string>();
let recoveryDone = false;
let migrationDone = false;


/** 标记当前进程内的活跃安装任务（避免 recover 误判） */
export function markInstallJobActive(jobId: string): void {
  activeJobIds.add(jobId.trim());
}


/** 取消活跃标记（任务结束） */
export function unmarkInstallJobActive(jobId: string): void {
  activeJobIds.delete(jobId.trim());
}


/** 安装任务持久化目录 */
function installJobsDir(): string {
  return getLocalLlmInstallJobsDir();
}


/** 一次性迁移：local_llm/.install-jobs → .chattingcursor/local-llm-install-jobs，并删除遗留目录 */
async function migrateLegacyInstallJobsDir(): Promise<void> {
  if (migrationDone) {
    return;
  }
  migrationDone = true;
  const legacyDir = path.join(getLocalLlmRootDir(), LEGACY_INSTALL_JOBS_DIR);
  const targetDir = installJobsDir();
  if (legacyDir === targetDir) {
    return;
  }
  let names: string[] = [];
  try {
    names = await readdir(legacyDir);
  } catch {
    return;
  }
  if (names.length > 0) {
    await mkdir(targetDir, { recursive: true });
    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const from = path.join(legacyDir, name);
      const to = path.join(targetDir, name);
      try {
        await rename(from, to);
      } catch {
        continue;
      }
    }
  }
  try {
    await rm(legacyDir, { recursive: true, force: true });
  } catch {
    // 遗留目录可能被占用，下次启动再试
  }
}


/** 将 jobId 转为安全文件名 */
function installJobFileName(jobId: string): string {
  const safe = jobId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safe}.json`;
}


/** 同步写入内存缓存（POST 返回 jobId 前必须先调用，避免轮询 404） */
export function cacheInstallJob(status: InstallJobStatus): void {
  installJobs.set(status.jobId, status);
}


/** 写入磁盘并在内存中缓存安装任务 */
export async function saveInstallJob(status: InstallJobStatus): Promise<void> {
  await migrateLegacyInstallJobsDir();
  cacheInstallJob(status);
  const dir = installJobsDir();
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, installJobFileName(status.jobId)),
    `${JSON.stringify(status, null, 2)}\n`,
    "utf8",
  );
}


/** 从磁盘读取单个安装任务 */
async function readInstallJobFromDisk(jobId: string): Promise<InstallJobStatus | null> {
  try {
    const raw = await readFile(path.join(installJobsDir(), installJobFileName(jobId)), "utf8");
    return JSON.parse(raw) as InstallJobStatus;
  } catch {
    return null;
  }
}


/** Bridge 重启后将未完成的 running 任务标记为 error，避免轮询 404 */
export async function recoverStaleInstallJobs(): Promise<void> {
  if (recoveryDone) {
    return;
  }
  recoveryDone = true;
  await migrateLegacyInstallJobsDir();
  let names: string[] = [];
  try {
    names = await readdir(installJobsDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      const raw = await readFile(path.join(installJobsDir(), name), "utf8");
      const status = JSON.parse(raw) as InstallJobStatus;
      if (status.state !== "running") {
        installJobs.set(status.jobId, status);
        continue;
      }
      if (activeJobIds.has(status.jobId)) {
        installJobs.set(status.jobId, status);
        continue;
      }
      const recovered: InstallJobStatus = {
        ...status,
        state: "error",
        progress: "失败",
        error: "Bridge 已重启，安装任务已中断。请重新安装。",
      };
      await saveInstallJob(recovered);
    } catch {
      continue;
    }
  }
}


/** 查询安装任务（内存 + 磁盘） */
export async function getInstallJobStatus(jobId: string): Promise<InstallJobStatus | null> {
  await recoverStaleInstallJobs();
  const trimmed = jobId.trim();
  if (!trimmed) {
    return null;
  }
  const cached = installJobs.get(trimmed);
  if (cached) {
    return cached;
  }
  const disk = await readInstallJobFromDisk(trimmed);
  if (!disk) {
    return null;
  }
  installJobs.set(trimmed, disk);
  return disk;
}


/** 重置内存缓存（仅测试） */
export function resetInstallJobsForTest(): void {
  installJobs.clear();
  activeJobIds.clear();
  recoveryDone = false;
  migrationDone = false;
}
