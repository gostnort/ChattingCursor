import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { KnowledgeNode } from "@chatting-cursor/shared";
import { getKnowledgeDir } from "../paths.js";


const INDEX_FILE = "index.json";
const CONTENT_DIR = "content";
const ROOT_ID = "root";


interface WikiIndexNode {
  id: string;
  name: string;
  parentId: string | null;
  /** 上传时标注的标签，用于对话中按标签检索 */
  tags?: string[];
}


interface WikiIndexFile {
  rootId: string;
  nodes: Record<string, WikiIndexNode>;
}


/** 读取 wiki 索引路径 */
function getIndexPath(): string {
  return path.join(getKnowledgeDir(), INDEX_FILE);
}


/** 节点 markdown 文件路径 */
function getContentPath(nodeId: string): string {
  return path.join(getKnowledgeDir(), CONTENT_DIR, `${nodeId}.md`);
}


/** 确保知识库目录存在 */
async function ensureKnowledgeLayout(): Promise<void> {
  const base = getKnowledgeDir();
  await mkdir(path.join(base, CONTENT_DIR), { recursive: true });
  const indexPath = getIndexPath();
  try {
    await readFile(indexPath, "utf8");
  } catch {
    const initial: WikiIndexFile = {
      rootId: ROOT_ID,
      nodes: {
        [ROOT_ID]: { id: ROOT_ID, name: "根", parentId: null },
      },
    };
    await mkdir(base, { recursive: true });
    await writeFile(indexPath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
  }
}


/** 加载索引 */
async function loadIndex(): Promise<WikiIndexFile> {
  await ensureKnowledgeLayout();
  const raw = await readFile(getIndexPath(), "utf8");
  const parsed = JSON.parse(raw) as WikiIndexFile;
  if (!parsed.nodes?.[parsed.rootId ?? ROOT_ID]) {
    throw new Error("知识库 index.json 无效：缺少根节点");
  }
  return parsed;
}


/** 保存索引 */
async function saveIndex(index: WikiIndexFile): Promise<void> {
  await writeFile(getIndexPath(), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}


/** 判断节点是否存在内容文件 */
async function nodeHasContent(nodeId: string): Promise<boolean> {
  try {
    const text = await readFile(getContentPath(nodeId), "utf8");
    return text.trim().length > 0;
  } catch {
    return false;
  }
}


/** 转为 API 节点 */
function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags?.length) {
    return [];
  }
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag.length < 1) {
      continue;
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ordered.push(tag);
  }
  return ordered;
}


async function toApiNode(node: WikiIndexNode): Promise<KnowledgeNode> {
  return {
    id: node.id,
    name: node.name,
    parentId: node.parentId,
    hasContent: await nodeHasContent(node.id),
    tags: normalizeTags(node.tags),
  };
}


/** 列出 wiki 树 */
export async function listKnowledgeTree(): Promise<{
  knowledgeDir: string;
  rootId: string;
  nodes: KnowledgeNode[];
}> {
  const index = await loadIndex();
  const nodes = await Promise.all(Object.values(index.nodes).map((node) => toApiNode(node)));
  return {
    knowledgeDir: getKnowledgeDir(),
    rootId: index.rootId,
    nodes,
  };
}


/** 重命名节点或更新元数据 */
export async function updateKnowledgeNode(
  nodeId: string,
  patch: { name?: string; tags?: string[] },
): Promise<KnowledgeNode> {
  const index = await loadIndex();
  if (!index.nodes[nodeId]) {
    throw new Error("节点不存在");
  }
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) {
      throw new Error("节点名称不能为空");
    }
    index.nodes[nodeId].name = trimmed;
  }
  if (patch.tags !== undefined) {
    index.nodes[nodeId].tags = normalizeTags(patch.tags);
  }
  await saveIndex(index);
  return toApiNode(index.nodes[nodeId]);
}


/** 重命名节点 */
export async function renameKnowledgeNode(nodeId: string, name: string): Promise<KnowledgeNode> {
  return updateKnowledgeNode(nodeId, { name });
}


/** 在父节点下创建子节点 */
export async function createKnowledgeChild(parentId: string, name: string): Promise<KnowledgeNode> {
  const index = await loadIndex();
  if (!index.nodes[parentId]) {
    throw new Error("父节点不存在");
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("节点名称不能为空");
  }
  const id = uuidv4();
  index.nodes[id] = { id, name: trimmed, parentId };
  await saveIndex(index);
  return toApiNode(index.nodes[id]);
}


/** 上传或覆盖节点 markdown（可选同时写入标签） */
export async function uploadKnowledgeMarkdown(
  nodeId: string,
  markdown: string,
  tags?: string[],
): Promise<number> {
  const index = await loadIndex();
  if (!index.nodes[nodeId]) {
    throw new Error("节点不存在");
  }
  if (tags !== undefined) {
    index.nodes[nodeId].tags = normalizeTags(tags);
    await saveIndex(index);
  }
  const bytes = Buffer.byteLength(markdown, "utf8");
  await mkdir(path.join(getKnowledgeDir(), CONTENT_DIR), { recursive: true });
  await writeFile(getContentPath(nodeId), markdown, "utf8");
  return bytes;
}


/** 列出知识库中所有不重复标签 */
export async function listAllKnowledgeTags(): Promise<string[]> {
  const index = await loadIndex();
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const node of Object.values(index.nodes)) {
    for (const tag of normalizeTags(node.tags)) {
      const key = tag.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags.sort((left, right) => left.localeCompare(right, "zh-CN"));
}


/** 按标签 OR 匹配节点（需有内容） */
export async function searchKnowledgeNodesByTags(
  tags: string[],
): Promise<Array<WikiIndexNode & { tags: string[] }>> {
  const index = await loadIndex();
  const normalizedTags = tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0);
  if (normalizedTags.length === 0) {
    return [];
  }
  const matched: Array<WikiIndexNode & { tags: string[] }> = [];
  for (const node of Object.values(index.nodes)) {
    const nodeTags = normalizeTags(node.tags);
    const hit = nodeTags.some((tag) => normalizedTags.includes(tag.toLowerCase()));
    if (!hit) {
      continue;
    }
    if (!(await nodeHasContent(node.id))) {
      continue;
    }
    matched.push({ ...node, tags: nodeTags });
  }
  return matched;
}


/** 收集某节点子树 id（含自身） */
function collectSubtreeIds(index: WikiIndexFile, nodeId: string): string[] {
  const ids = [nodeId];
  for (const node of Object.values(index.nodes)) {
    if (node.parentId === nodeId) {
      ids.push(...collectSubtreeIds(index, node.id));
    }
  }
  return ids;
}


/** 删除节点及其子树（不可删根） */
export async function deleteKnowledgeNode(nodeId: string): Promise<void> {
  const index = await loadIndex();
  if (nodeId === index.rootId) {
    throw new Error("不能删除根节点");
  }
  if (!index.nodes[nodeId]) {
    throw new Error("节点不存在");
  }
  const toRemove = collectSubtreeIds(index, nodeId);
  for (const id of toRemove) {
    delete index.nodes[id];
    try {
      await unlink(getContentPath(id));
    } catch {
      // 无内容文件时忽略
    }
  }
  await saveIndex(index);
}


/** 读取节点 markdown（无则空串） */
export async function readKnowledgeMarkdown(nodeId: string): Promise<string> {
  try {
    return await readFile(getContentPath(nodeId), "utf8");
  } catch {
    return "";
  }
}


/** 按先根顺序遍历子树 */
function walkSubtree(index: WikiIndexFile, nodeId: string): WikiIndexNode[] {
  const node = index.nodes[nodeId];
  if (!node) {
    return [];
  }
  const children = Object.values(index.nodes)
    .filter((item) => item.parentId === nodeId)
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const ordered: WikiIndexNode[] = [node];
  for (const child of children) {
    ordered.push(...walkSubtree(index, child.id));
  }
  return ordered;
}


/** 为离线模型拼装知识上下文（从根向下，字符预算内） */
export async function buildKnowledgeContext(maxChars = 12000): Promise<string> {
  const index = await loadIndex();
  const ordered = walkSubtree(index, index.rootId);
  const parts: string[] = [];
  let used = 0;
  for (const node of ordered) {
    const md = (await readKnowledgeMarkdown(node.id)).trim();
    if (!md) {
      continue;
    }
    const block = `## ${node.name} (${node.id})\n${md}`;
    if (used + block.length > maxChars) {
      const remaining = maxChars - used;
      if (remaining > 200) {
        parts.push(`${block.slice(0, remaining)}\n...(truncated)`);
      }
      break;
    }
    parts.push(block);
    used += block.length + 2;
  }
  if (parts.length === 0) {
    return "";
  }
  return ["# 知识库", ...parts].join("\n\n");
}
