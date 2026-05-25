import { mkdir, readdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";


const RETENTION_DAYS = 7;
const SNIPPET_CONTEXT_CHARS = 80;


/** 历史记录存储 */
export class HistoryStore {
  private dir: string;


  constructor(dir?: string) {
    this.dir = dir ?? path.join(os.homedir(), ".chattingcursor", "history");
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
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
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


  /** 搜索本地历史文本 */
  async search(query: string): Promise<Array<{ file: string; snippet: string; line?: number }>> {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
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
        const matchIndex = lower.indexOf(keyword);
        if (matchIndex < 0) {
          continue;
        }
        const start = Math.max(0, matchIndex - SNIPPET_CONTEXT_CHARS);
        const end = Math.min(line.length, matchIndex + keyword.length + SNIPPET_CONTEXT_CHARS);
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
