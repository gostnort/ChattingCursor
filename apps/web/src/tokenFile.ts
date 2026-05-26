/** 从 token 文件正文解析当天口令 */
export function parseTodayTokenFromContent(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim().toLowerCase();
    if (key === "token") {
      return trimmed.slice(separator + 1).trim();
    }
  }
  return "";
}
