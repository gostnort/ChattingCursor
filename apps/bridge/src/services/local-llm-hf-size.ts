import { readdir, stat } from "node:fs/promises";
import path from "node:path";


function encodeHfRepoId(repoId: string): string {
  return repoId
    .split("/")
    .map((segment) => encodeURIComponent(segment.trim()))
    .filter(Boolean)
    .join("/");
}


function resolveHfToken(): string {
  return process.env.HF_TOKEN?.trim() || process.env.HUGGINGFACE_HUB_TOKEN?.trim() || "";
}


export type HfTreeFileEntry = {
  path?: string;
  type?: string;
  size?: number;
  lfs?: { size?: number };
};


/** 从 HF tree 条目解析单文件字节数（优先 LFS 实际大小） */
export function bytesFromHfTreeEntry(entry: HfTreeFileEntry): number | null {
  const lfsSize = entry.lfs?.size;
  if (typeof lfsSize === "number" && lfsSize > 0) {
    return lfsSize;
  }
  if (typeof entry.size === "number" && entry.size > 0) {
    return entry.size;
  }
  return null;
}


/** 对所选 filenames 在 tree 中聚合总字节；任一分片无 size 则返回 null */
export function sumSelectedHfFileBytes(tree: HfTreeFileEntry[], filenames: string[]): number | null {
  const normalized = filenames.map((name) => name.replace(/\\/g, "/").trim()).filter(Boolean);
  if (normalized.length === 0) {
    return null;
  }
  const byPath = new Map<string, HfTreeFileEntry>();
  for (const entry of tree) {
    if (entry.type === "file" && typeof entry.path === "string") {
      byPath.set(entry.path, entry);
    }
  }
  let total = 0;
  for (const filename of normalized) {
    const entry = byPath.get(filename);
    if (!entry) {
      return null;
    }
    const bytes = bytesFromHfTreeEntry(entry);
    if (bytes === null) {
      return null;
    }
    total += bytes;
  }
  return total;
}


/** Hugging Face Hub：递归文件树（expand=true 以获取 size / LFS 元数据） */
export async function fetchHfRepoTreeWithSizes(repoId: string, revision: string): Promise<HfTreeFileEntry[]> {
  const token = resolveHfToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const encoded = encodeHfRepoId(repoId);
  const params = new URLSearchParams({ recursive: "true", expand: "true" });
  const response = await fetch(
    `https://huggingface.co/api/models/${encoded}/tree/${encodeURIComponent(revision)}?${params.toString()}`,
    { headers, signal: AbortSignal.timeout(120_000) },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HF 文件树失败 (${response.status}, ${revision}): ${body.slice(0, 300)}`);
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload as HfTreeFileEntry[] : [];
}


/** HEAD resolve URL 获取 Content-Length（tree 无 size 时的兜底） */
async function headHfResolveFileSize(repoId: string, revision: string, filePath: string): Promise<number | null> {
  const token = resolveHfToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const segments = filePath.replace(/\\/g, "/").split("/").map((segment) => encodeURIComponent(segment));
  const url = `https://huggingface.co/${encodeHfRepoId(repoId)}/resolve/${encodeURIComponent(revision)}/${segments.join("/")}`;
  const response = await fetch(url, { method: "HEAD", headers, redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    return null;
  }
  const length = response.headers.get("content-length");
  if (!length) {
    return null;
  }
  const parsed = Number.parseInt(length, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}


/** 解析所选 GGUF 分片在 HF 上的总字节（main/master + HEAD 兜底） */
export async function resolveHfFilenamesTotalBytes(repoId: string, filenames: string[]): Promise<number | null> {
  const revisions = ["main", "master"];
  let lastError = "";
  for (const revision of revisions) {
    try {
      const tree = await fetchHfRepoTreeWithSizes(repoId, revision);
      const fromTree = sumSelectedHfFileBytes(tree, filenames);
      if (fromTree !== null) {
        return fromTree;
      }
      let total = 0;
      let resolvedAny = false;
      for (const filename of filenames) {
        const headSize = await headHfResolveFileSize(repoId, revision, filename);
        if (headSize === null) {
          return null;
        }
        total += headSize;
        resolvedAny = true;
      }
      if (resolvedAny) {
        return total;
      }
      lastError = `revision ${revision} 无法解析文件大小`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  if (lastError) {
    return null;
  }
  return null;
}


/** 递归统计目录当前占用字节（含 .cache 等子目录） */
export async function measureDirectoryBytes(dir: string): Promise<number> {
  let total = 0;
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        const info = await stat(full);
        total += info.size;
      } catch {
        continue;
      }
    }
  }
  await walk(dir);
  return total;
}


/** 根据已下载/总量计算百分比（总量未知则 null） */
export function computeDownloadPercent(downloadedBytes: number, totalBytes: number | null | undefined): number | null {
  if (totalBytes === null || totalBytes === undefined || totalBytes <= 0) {
    return null;
  }
  const ratio = downloadedBytes / totalBytes;
  return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}


/** 格式化为 GB 显示（安装进度文案） */
export function formatBytesGbLabel(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  }
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(2)} MB`;
  }
  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}


/** 生成「已下载 X / Y (Z%)」类进度文案 */
export function formatInstallProgressLabel(
  downloadedBytes: number,
  totalBytes: number | null | undefined,
  percent: number | null | undefined,
): string {
  const downloaded = formatBytesGbLabel(downloadedBytes);
  if (totalBytes === null || totalBytes === undefined || totalBytes <= 0) {
    return `已下载 ${downloaded}（计算中…）`;
  }
  const total = formatBytesGbLabel(totalBytes);
  const pct = percent ?? computeDownloadPercent(downloadedBytes, totalBytes);
  if (pct === null) {
    return `已下载 ${downloaded} / ${total}`;
  }
  return `已下载 ${downloaded} / ${total} (${pct}%)`;
}
