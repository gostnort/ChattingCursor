import { createWriteStream } from "node:fs";
import { access, mkdir, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { MultipartFile } from "@fastify/multipart";
import { getUploadsDir } from "../paths.js";


const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);


const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};


/** 已上传图片元数据 */
export interface StoredImage {
  imageId: string;
  sessionId: string;
  fileName: string;
  absolutePath: string;
  mimeType: string;
}


/** 根据 MIME 推断扩展名 */
function resolveExtension(mimeType: string, fileName: string): string {
  const fromMime = EXT_BY_MIME[mimeType];
  if (fromMime) {
    return fromMime;
  }
  const ext = path.extname(fileName).toLowerCase();
  if (ext && [".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
    return ext === ".jpeg" ? ".jpg" : ext;
  }
  return ".png";
}


/** 保存 multipart 图片到会话目录 */
export async function saveUploadedImage(
  sessionId: string,
  imageId: string,
  file: MultipartFile,
): Promise<StoredImage> {
  const mimeType = file.mimetype || "application/octet-stream";
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported image MIME type: ${mimeType}`);
  }
  const fileName = path.basename(file.filename || "image.png");
  const ext = resolveExtension(mimeType, fileName);
  const sessionDir = path.join(getUploadsDir(), sessionId);
  await mkdir(sessionDir, { recursive: true });
  const absolutePath = path.join(sessionDir, `${imageId}${ext}`);
  await pipeline(file.file, createWriteStream(absolutePath));
  return {
    imageId,
    sessionId,
    fileName,
    absolutePath,
    mimeType,
  };
}


/** 解析已上传图片的绝对路径 */
export async function resolveStoredImagePath(sessionId: string, imageId: string): Promise<string | null> {
  const sessionDir = path.join(getUploadsDir(), sessionId);
  let entries: string[] | null = null;
  try {
    await access(sessionDir, constants.F_OK);
    entries = await readdir(sessionDir);
  } catch {
    entries = null;
  }
  if (!entries) {
    return null;
  }
  const match = entries.find((name) => name.startsWith(`${imageId}.`) || name === imageId);
  if (!match) {
    return null;
  }
  return path.join(sessionDir, match);
}


/** 读取已上传图片用于 HTTP 响应 */
export async function readStoredImage(sessionId: string, imageId: string): Promise<{
  absolutePath: string;
  mimeType: string;
} | null> {
  const absolutePath = await resolveStoredImagePath(sessionId, imageId);
  if (!absolutePath) {
    return null;
  }
  try {
    await access(absolutePath, constants.R_OK);
    await stat(absolutePath);
  } catch {
    return null;
  }
  const ext = path.extname(absolutePath).toLowerCase();
  const mimeType = ext === ".jpg" || ext === ".jpeg"
    ? "image/jpeg"
    : ext === ".png"
      ? "image/png"
      : ext === ".gif"
        ? "image/gif"
        : ext === ".webp"
          ? "image/webp"
          : "application/octet-stream";
  return { absolutePath, mimeType };
}
