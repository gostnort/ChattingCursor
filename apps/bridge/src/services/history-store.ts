import { mkdir, readdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { getDefaultHistoryDir } from "../paths.js";


export const HISTORY_RETENTION_DAYS = 7;
const SNIPPET_CONTEXT_CHARS = 80;


/** 历史记录存储 */
export class HistoryStore {
  private dir: string;


  constructor(dir?: string) {
    this.dir = dir ?? getDefaultHistoryDir();
  }


  /** 历史目录绝对路径 */
  getDirectory(): string {
    return this.dir;
  }


  /** 历史保留天数 */
  getRetentionDays(): number {
    return HISTORY_RETENTION_DAYS;
  }


  /** 确保历史目录存在 */
  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }


  /** 获取会话历史文件路径 */
  private sessionFilePath(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.txt`);
  }


  /** 追加一次完成的对话回合 */
  async appendTurn(
    sessionId: string,
    userText: string,
    assistantText: string,
    createdAt: string,
  ): Promise<void> {
    await this.ensureDir();
    const filePath = this.sessionFilePath(sessionId);
    const header = `[${createdAt}] Session ${sessionId}\n`;
    const block = [
      `[${new Date().toISOString()}] User:`,
      userText,
      "",
      `[${new Date().toISOString()}] Assistant:`,
      assistantText,
      "",
      "---",
      "",
    ].join("\n");
    let prefix = "";
    try {
      await readFile(filePath, "utf8");
    } catch {
      prefix = header;
    }
    await writeFile(filePath, prefix + block, { flag: "a" });
    await this.cleanupOldFiles();
  }


  /** 删除超过保留期的历史文件 */
  async cleanupOldFiles(): Promise<void> {
    await this.ensureDir();
    const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith(".txt")) {
        continue;
      }
      const filePath = path.join(this.dir, name);
      try {
        const info = await stat(filePath);
        if (info.mtimeMs < cutoff) {
          await unlink(filePath);
        }
      } catch {
        // 忽略单个文件清理失败
      }
    }
  }


  /** 列出所有会话历史文件（按修改时间倒序） */
  async listSessions(): Promise<Array<{ file: string; sessionId: string; sizeBytes: number; modifiedAt: string }>> {
    await this.cleanupOldFiles();
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const items: Array<{ file: string; sessionId: string; sizeBytes: number; modifiedAt: string }> = [];
    for (const name of entries) {
      if (!name.endsWith(".txt")) {
        continue;
      }
      const filePath = path.join(this.dir, name);
      try {
        const info = await stat(filePath);
        items.push({
          file: name,
          sessionId: name.replace(/\.txt$/, ""),
          sizeBytes: info.size,
          modifiedAt: new Date(info.mtimeMs).toISOString(),
        });
      } catch {
        // 忽略单个文件读取失败
      }
    }
    items.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
    return items;
  }


  /** 读取指定历史文件全文 */
  async readSessionFile(fileName: string): Promise<string | null> {
    if (!/^[\w-]+\.txt$/.test(fileName)) {
      return null;
    }
    const filePath = path.join(this.dir, fileName);
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }


  /** 搜索本地历史文本（支持多关键词 OR 匹配） */
  async search(query: string | string[]): Promise<Array<{ file: string; snippet: string; line?: number }>> {
    const keywords = (Array.isArray(query) ? query : [query])
      .map((term) => term.trim().toLowerCase())
      .filter((term) => term.length >= 2);
    if (keywords.length === 0) {
      return [];
    }
    await this.cleanupOldFiles();
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const hits: Array<{ file: string; snippet: string; line?: number }> = [];
    for (const name of entries) {
      if (!name.endsWith(".txt")) {
        continue;
      }
      const filePath = path.join(this.dir, name);
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const lower = line.toLowerCase();
        let matchedKeyword = "";
        let matchIndex = -1;
        for (const keyword of keywords) {
          const foundAt = lower.indexOf(keyword);
          if (foundAt >= 0) {
            matchedKeyword = keyword;
            matchIndex = foundAt;
            break;
          }
        }
        if (matchIndex < 0) {
          continue;
        }
        const start = Math.max(0, matchIndex - SNIPPET_CONTEXT_CHARS);
        const end = Math.min(line.length, matchIndex + matchedKeyword.length + SNIPPET_CONTEXT_CHARS);
        const snippet = (start > 0 ? "…" : "") + line.slice(start, end) + (end < line.length ? "…" : "");
        hits.push({ file: name, snippet, line: index + 1 });
        if (hits.length >= 50) {
          return hits;
        }
      }
    }
    return hits;
  }
}


export const historyStore = new HistoryStore(
  process.env.CHATTINGCURSOR_HISTORY_DIR?.trim() || undefined,
);
