import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";


export interface DailyTokenRecord {
  token: string;
  date: string;
  filePath: string;
}


function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}


function defaultTokenDirectory(): string {
  return path.join(os.homedir(), "ChattingCursorTokenSync");
}


function parseTokenFile(content: string): { date?: string; token?: string } {
  const lines = content.split(/\r?\n/);
  const parsed: { date?: string; token?: string } = {};
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
  }
  return parsed;
}


export class TokenRotationService {
  private directory: string;
  private fileName: string;
  private publicBridgeUrl: string;
  private cachedRecord: DailyTokenRecord | null = null;


  constructor(options: { directory?: string; fileName?: string; publicBridgeUrl: string }) {
    this.directory = options.directory?.trim() || defaultTokenDirectory();
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
    await this.ensureTodayToken();
  }


  getFilePath(): string {
    return path.join(this.directory, this.fileName);
  }


  getFileName(): string {
    return this.fileName;
  }


  getToday(): string {
    return todayStamp();
  }


  async ensureTodayToken(): Promise<DailyTokenRecord> {
    const today = this.getToday();
    if (this.cachedRecord?.date === today) {
      return this.cachedRecord;
    }
    const filePath = this.getFilePath();
    await mkdir(this.directory, { recursive: true });
    try {
      const existing = await readFile(filePath, "utf8");
      const parsed = parseTokenFile(existing);
      if (parsed.date === today && parsed.token) {
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
  directory: process.env.CHATTINGCURSOR_TOKEN_SYNC_DIR,
  fileName: process.env.CHATTINGCURSOR_TOKEN_FILE_NAME,
  publicBridgeUrl: process.env.BRIDGE_PUBLIC_URL?.trim() || "http://127.0.0.1:4321",
});
