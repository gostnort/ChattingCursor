import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  getDefaultTokenSyncDir,
  getLegacyTokenSyncDir,
} from "../paths.js";
import { resolveTokenSyncDirectory, saveTokenSyncDirectory } from "./user-config.js";


export interface DailyTokenRecord {
  token: string;
  date: string;
  filePath: string;
}


function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}


function parseTokenFile(content: string): { date?: string; token?: string; publicBridgeUrl?: string } {
  const lines = content.split(/\r?\n/);
  const parsed: { date?: string; token?: string; publicBridgeUrl?: string } = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim().toLowerCase();
    const value = trimmed.slice(separator + 1).trim();
    if (key === "date") {
      parsed.date = value;
    }
    if (key === "token") {
      parsed.token = value;
    }
    if (key === "publicbridgeurl") {
      parsed.publicBridgeUrl = normalizePublicBridgeUrl(value);
    }
  }
  return parsed;
}


function normalizePublicBridgeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("公开 Bridge URL 不能为空");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^[a-z0-9-]+\.trycloudflare\.com$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}


function upsertPublicBridgeUrlLine(content: string, url: string): string {
  const lines = content.split(/\r?\n/);
  let replaced = false;
  const updated = lines.map((line) => {
    const trimmed = line.trim().toLowerCase();
    if (trimmed.startsWith("publicbridgeurl:")) {
      replaced = true;
      return `publicBridgeUrl: ${url}`;
    }
    return line;
  });
  if (!replaced) {
    const insertAt = updated.findIndex((line) => line.trim().toLowerCase().startsWith("generatedat:"));
    const line = `publicBridgeUrl: ${url}`;
    if (insertAt >= 0) {
      updated.splice(insertAt + 1, 0, line);
    } else {
      updated.unshift(line);
    }
  }
  return updated.join("\n");
}


export class TokenRotationService {
  private directory: string;
  private fileName: string;
  private publicBridgeUrl: string;
  private cachedRecord: DailyTokenRecord | null = null;


  constructor(options: { directory?: string; fileName?: string; publicBridgeUrl: string }) {
    this.directory = options.directory?.trim() || resolveTokenSyncDirectory();
    this.fileName = options.fileName?.trim() || "chattingcursor-token.txt";
    this.publicBridgeUrl = options.publicBridgeUrl;
  }


  getDirectory(): string {
    return this.directory;
  }


  async setDirectory(directory: string): Promise<void> {
    const normalized = directory.trim();
    if (!normalized) {
      throw new Error("同步目录不能为空");
    }
    this.directory = normalized;
    this.cachedRecord = null;
    await mkdir(this.directory, { recursive: true });
    await saveTokenSyncDirectory(normalized);
    await this.ensureTodayToken();
  }


  getFilePath(): string {
    return path.join(this.directory, this.fileName);
  }


  getFileName(): string {
    return this.fileName;
  }


  getPublicBridgeUrl(): string {
    return this.publicBridgeUrl;
  }


  async updatePublicBridgeUrl(url: string): Promise<string> {
    const normalized = normalizePublicBridgeUrl(url);
    this.publicBridgeUrl = normalized;
    await this.ensureTodayToken();
    // ensureTodayToken 可能从文件读回 localhost，写入前恢复隧道地址
    this.publicBridgeUrl = normalized;
    const filePath = this.getFilePath();
    const existing = await readFile(filePath, "utf8");
    const next = upsertPublicBridgeUrlLine(existing, normalized);
    const withTrailingNewline = next.endsWith("\n") ? next : `${next}\n`;
    await writeFile(filePath, withTrailingNewline, "utf8");
    return normalized;
  }


  getToday(): string {
    return todayStamp();
  }


  async migrateLegacyTokenFileIfNeeded(): Promise<void> {
    const targetPath = this.getFilePath();
    const legacyPath = path.join(getLegacyTokenSyncDir(), this.fileName);
    if (path.resolve(this.directory) === path.resolve(getLegacyTokenSyncDir())) {
      return;
    }
    if (path.resolve(this.directory) !== path.resolve(getDefaultTokenSyncDir())) {
      return;
    }
    try {
      await access(targetPath);
      return;
    } catch {
      // 新路径尚无文件，尝试从旧目录迁移
    }
    try {
      await access(legacyPath);
      await mkdir(this.directory, { recursive: true });
      await copyFile(legacyPath, targetPath);
      console.log(`[token] 已从旧目录迁移口令文件: ${legacyPath} -> ${targetPath}`);
    } catch {
      // 旧目录无文件则跳过
    }
  }


  async ensureTodayToken(): Promise<DailyTokenRecord> {
    const today = this.getToday();
    if (this.cachedRecord?.date === today) {
      return this.cachedRecord;
    }
    const filePath = this.getFilePath();
    await mkdir(this.directory, { recursive: true });
    await this.migrateLegacyTokenFileIfNeeded();
    try {
      const existing = await readFile(filePath, "utf8");
      const parsed = parseTokenFile(existing);
      if (parsed.date === today && parsed.token) {
        if (parsed.publicBridgeUrl) {
          this.publicBridgeUrl = parsed.publicBridgeUrl;
          const upgraded = upsertPublicBridgeUrlLine(existing, parsed.publicBridgeUrl);
          if (upgraded !== existing) {
            const withTrailingNewline = upgraded.endsWith("\n") ? upgraded : `${upgraded}\n`;
            await writeFile(filePath, withTrailingNewline, "utf8");
          }
        }
        this.cachedRecord = {
          date: today,
          token: parsed.token,
          filePath,
        };
        return this.cachedRecord;
      }
    } catch {
      // 文件不存在时创建新口令
    }
    const token = randomBytes(24).toString("base64url");
    const content = [
      `date: ${today}`,
      `token: ${token}`,
      `generatedAt: ${new Date().toISOString()}`,
      `publicBridgeUrl: ${this.publicBridgeUrl}`,
      "",
      "把今天的 token 输入手机网页后即可连接远程 Bridge。",
      "此文件应位于云盘同步目录，供手机查看。",
      "",
    ].join("\n");
    await writeFile(filePath, content, "utf8");
    this.cachedRecord = { date: today, token, filePath };
    return this.cachedRecord;
  }


  async verifyToken(candidate: string | undefined): Promise<boolean> {
    if (!candidate?.trim()) {
      return false;
    }
    const current = await this.ensureTodayToken();
    const left = Buffer.from(candidate.trim(), "utf8");
    const right = Buffer.from(current.token, "utf8");
    if (left.length !== right.length) {
      return false;
    }
    return timingSafeEqual(left, right);
  }


  async readTodayTokenFileContent(): Promise<{ content: string; date: string; fileName: string }> {
    const record = await this.ensureTodayToken();
    const content = await readFile(record.filePath, "utf8");
    return {
      content,
      date: record.date,
      fileName: this.fileName,
    };
  }
}


export const tokenRotationService = new TokenRotationService({
  directory: resolveTokenSyncDirectory(),
  fileName: process.env.CHATTINGCURSOR_TOKEN_FILE_NAME,
  publicBridgeUrl: process.env.BRIDGE_PUBLIC_URL?.trim() || "http://127.0.0.1:4321",
});
