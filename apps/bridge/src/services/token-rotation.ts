import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  getChattingCursorHomeDir,
  getDefaultTokenSyncDir,
  getLegacyTokenSyncDir,
} from "../paths.js";
import { resolveTokenSyncDirectory, saveTokenSyncDirectory } from "./user-config.js";


export interface DailyTokenRecord {
  token: string;
  date: string;
  filePath: string;
}


interface ParsedTokenFile {
  datetime?: string;
  date?: string;
  token?: string;
  salt?: string;
  publicBridgeUrl?: string;
  generatedAt?: string;
}


interface TokenMetaRecord {
  salt: string;
}


function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}


function nowIso(): string {
  return new Date().toISOString();
}


function effectiveTokenDay(parsed: ParsedTokenFile): string | undefined {
  if (parsed.datetime) {
    return parsed.datetime.slice(0, 10);
  }
  return parsed.date;
}


function parseTokenFile(content: string): ParsedTokenFile {
  const lines = content.split(/\r?\n/);
  const parsed: ParsedTokenFile = {};
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
    if (key === "datetime") {
      parsed.datetime = value;
    }
    if (key === "date") {
      parsed.date = value;
    }
    if (key === "token") {
      parsed.token = value;
    }
    if (key === "salt") {
      parsed.salt = value;
    }
    if (key === "generatedat") {
      parsed.generatedAt = value;
    }
    if (key === "publicbridgeurl") {
      parsed.publicBridgeUrl = normalizePublicBridgeUrl(value);
    }
  }
  return parsed;
}


function tokenMetaPath(syncDirectory: string): string {
  const hash = createHash("sha256").update(syncDirectory, "utf8").digest("hex").slice(0, 16);
  return path.join(getChattingCursorHomeDir(), `token-meta-${hash}.json`);
}


async function loadTokenMeta(syncDirectory: string): Promise<TokenMetaRecord | null> {
  const metaPath = tokenMetaPath(syncDirectory);
  try {
    const raw = await readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw) as TokenMetaRecord;
    if (parsed.salt?.trim()) {
      return { salt: parsed.salt.trim() };
    }
  } catch {
    // 无本地 meta 时走新建或从旧 token 文件迁移
  }
  return null;
}


async function saveTokenMeta(syncDirectory: string, meta: TokenMetaRecord): Promise<void> {
  const metaPath = tokenMetaPath(syncDirectory);
  await mkdir(getChattingCursorHomeDir(), { recursive: true });
  await writeFile(metaPath, `${JSON.stringify(meta)}\n`, "utf8");
}


function generateSalt(): string {
  return randomBytes(32).toString("base64url");
}


function deriveDailyToken(date: string, salt: string): string {
  return createHash("sha256")
    .update(`${date}:${salt}`, "utf8")
    .digest("base64url")
    .slice(0, 32);
}


function buildTokenFileContent(options: {
  datetime: string;
  token: string;
  publicBridgeUrl: string;
  generatedAt?: string;
}): string {
  const generatedAt = options.generatedAt ?? options.datetime;
  return [
    `datetime: ${options.datetime}`,
    `token: ${options.token}`,
    `generatedAt: ${generatedAt}`,
    `publicBridgeUrl: ${options.publicBridgeUrl}`,
    "",
  ].join("\n");
}


function normalizePublicBridgeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("Public Bridge URL cannot be empty");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^[a-z0-9-]+\.trycloudflare\.com$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}


function isLoopbackPublicBridgeUrl(url: string): boolean {
  try {
    const withProtocol = /^https?:\/\//i.test(url) ? url : `http://${url}`;
    const parsed = new URL(withProtocol);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}


function isTrycloudflarePublicBridgeUrl(url: string): boolean {
  return /trycloudflare\.com/i.test(url);
}


/** 磁盘与内存并存时，优先保留 trycloudflare，避免被 localhost 覆盖 */
function pickPreferredPublicBridgeUrl(current: string, fromFile?: string): string {
  const candidates = [current, fromFile].filter((item): item is string => Boolean(item?.trim()));
  const normalized = candidates.map((item) => normalizePublicBridgeUrl(item));
  const tunnel = normalized.find(isTrycloudflarePublicBridgeUrl);
  if (tunnel) {
    return tunnel;
  }
  const remote = normalized.find((item) => !isLoopbackPublicBridgeUrl(item));
  if (remote) {
    return remote;
  }
  return normalized[0] ?? current;
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


/** 从旧版含 salt 的同步文件迁入本地 meta，并重写为最小字段 */
async function migrateLegacySaltFromSyncedFile(
  filePath: string,
  syncDirectory: string,
  parsed: ParsedTokenFile,
  publicBridgeUrl: string,
): Promise<DailyTokenRecord | null> {
  if (!parsed.salt?.trim() || !parsed.token?.trim()) {
    return null;
  }
  const tokenDay = effectiveTokenDay(parsed);
  if (!tokenDay) {
    return null;
  }
  const salt = parsed.salt.trim();
  await saveTokenMeta(syncDirectory, { salt });
  const today = todayStamp();
  const datetime = parsed.datetime ?? (parsed.generatedAt ?? nowIso());
  const token =
    tokenDay === today
      ? parsed.token.trim()
      : deriveDailyToken(today, salt);
  const content = buildTokenFileContent({
    datetime: tokenDay === today ? datetime : nowIso(),
    token,
    publicBridgeUrl,
    generatedAt: parsed.generatedAt,
  });
  await writeFile(filePath, content, "utf8");
  return { date: today, token, filePath };
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
      throw new Error("Sync directory cannot be empty");
    }
    this.directory = normalized;
    this.cachedRecord = null;
    await mkdir(this.directory, { recursive: true });
    await saveTokenSyncDirectory(normalized);
    await this.regenerateTodayToken();
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
    if (next !== existing) {
      const withTrailingNewline = next.endsWith("\n") ? next : `${next}\n`;
      await writeFile(filePath, withTrailingNewline, "utf8");
    }
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
      console.log(`[token] Migrated token file from legacy directory: ${legacyPath} -> ${targetPath}`);
    } catch {
      // 旧目录无文件则跳过
    }
  }


  private async resolveSalt(existingMeta: TokenMetaRecord | null, parsed?: ParsedTokenFile): Promise<string> {
    if (existingMeta?.salt) {
      return existingMeta.salt;
    }
    if (parsed?.salt?.trim()) {
      const salt = parsed.salt.trim();
      await saveTokenMeta(this.directory, { salt });
      return salt;
    }
    const salt = generateSalt();
    await saveTokenMeta(this.directory, { salt });
    return salt;
  }


  private async writeTodayTokenFile(options: {
    token: string;
    publicBridgeUrl: string;
    generatedAt?: string;
    datetime?: string;
  }): Promise<DailyTokenRecord> {
    const today = this.getToday();
    const filePath = this.getFilePath();
    const datetime = options.datetime ?? nowIso();
    const content = buildTokenFileContent({
      datetime,
      token: options.token,
      publicBridgeUrl: options.publicBridgeUrl,
      generatedAt: options.generatedAt,
    });
    await writeFile(filePath, content, "utf8");
    this.cachedRecord = { date: today, token: options.token, filePath };
    return this.cachedRecord;
  }


  async regenerateTodayToken(): Promise<DailyTokenRecord> {
    this.cachedRecord = null;
    await mkdir(this.directory, { recursive: true });
    const today = this.getToday();
    const salt = await this.resolveSalt(await loadTokenMeta(this.directory));
    const token = deriveDailyToken(today, salt);
    return this.writeTodayTokenFile({
      token,
      publicBridgeUrl: this.publicBridgeUrl,
    });
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
      if (parsed.salt) {
        const migrated = await migrateLegacySaltFromSyncedFile(
          filePath,
          this.directory,
          parsed,
          pickPreferredPublicBridgeUrl(this.publicBridgeUrl, parsed.publicBridgeUrl),
        );
        if (migrated) {
          if (parsed.publicBridgeUrl) {
            this.publicBridgeUrl = pickPreferredPublicBridgeUrl(this.publicBridgeUrl, parsed.publicBridgeUrl);
          }
          this.cachedRecord = migrated;
          return migrated;
        }
      }
      const tokenDay = effectiveTokenDay(parsed);
      if (tokenDay === today && parsed.token) {
        if (parsed.publicBridgeUrl) {
          const preferred = pickPreferredPublicBridgeUrl(this.publicBridgeUrl, parsed.publicBridgeUrl);
          this.publicBridgeUrl = preferred;
          const upgraded = upsertPublicBridgeUrlLine(existing, preferred);
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
      const meta = await loadTokenMeta(this.directory);
      const salt = await this.resolveSalt(meta, parsed);
      if (tokenDay && tokenDay !== today) {
        const token = deriveDailyToken(today, salt);
        return this.writeTodayTokenFile({
          token,
          publicBridgeUrl: pickPreferredPublicBridgeUrl(this.publicBridgeUrl, parsed.publicBridgeUrl),
        });
      }
    } catch {
      // 文件不存在时创建新口令
    }
    const salt = await this.resolveSalt(await loadTokenMeta(this.directory));
    const token = deriveDailyToken(today, salt);
    return this.writeTodayTokenFile({
      token,
      publicBridgeUrl: this.publicBridgeUrl,
    });
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
