/** GGUF 分片文件名分组：去掉 -00001-of-00002 后缀，合并为一条 UI 选项 */

const SHARD_SUFFIX = /-(\d{5})-of-(\d{5})\.gguf$/i;


export type GgufGroupOption = {
  groupKey: string;
  displayLabel: string;
  folderPrefix: string;
  filenames: string[];
};


/** 去掉分片后缀得到分组键 */
export function stripGgufShardSuffix(filename: string): string {
  const normalized = filename.replace(/\\/g, "/");
  if (!SHARD_SUFFIX.test(normalized)) {
    return normalized.replace(/\.gguf$/i, "");
  }
  return normalized.replace(SHARD_SUFFIX, "");
}


/** 解析单个 GGUF 路径的分组键与展示名 */
export function parseGgufFileGroup(filename: string): { groupKey: string; displayLabel: string; folderPrefix: string } {
  const normalized = filename.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const folderPrefix = slash >= 0 ? `${normalized.slice(0, slash + 1)}` : "";
  const basename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  let stem = basename;
  if (SHARD_SUFFIX.test(basename)) {
    stem = basename.replace(SHARD_SUFFIX, "");
  } else {
    stem = basename.replace(/\.gguf$/i, "");
  }
  const groupKey = `${folderPrefix}${stem}`;
  const displayLabel = groupKey;
  return { groupKey, displayLabel, folderPrefix };
}


/** 判断文件是否属于同一 GGUF 分组 */
export function ggufFileMatchesGroup(filename: string, groupKey: string): boolean {
  return parseGgufFileGroup(filename).groupKey === groupKey;
}


/** 将仓库内 .gguf 文件列表合并为分组选项（多分片显示一行） */
export function groupGgufFilenames(filenames: string[]): GgufGroupOption[] {
  const buckets = new Map<string, GgufGroupOption>();
  for (const raw of filenames) {
    const name = raw.replace(/\\/g, "/").trim();
    if (!name.toLowerCase().endsWith(".gguf")) {
      continue;
    }
    const parsed = parseGgufFileGroup(name);
    const existing = buckets.get(parsed.groupKey);
    if (existing) {
      existing.filenames.push(name);
      continue;
    }
    buckets.set(parsed.groupKey, {
      groupKey: parsed.groupKey,
      displayLabel: parsed.displayLabel,
      folderPrefix: parsed.folderPrefix,
      filenames: [name],
    });
  }
  const groups = [...buckets.values()];
  for (const group of groups) {
    group.filenames.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  }
  groups.sort((left, right) => left.displayLabel.localeCompare(right.displayLabel, undefined, { numeric: true }));
  return groups;
}
