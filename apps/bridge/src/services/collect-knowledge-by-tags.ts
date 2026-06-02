import type { CollectedChunk } from "./external-data-pipeline.js";
import {
  extractKnowledgeTagsFromDialogue,
} from "./knowledge-tag-intent.js";
import {
  listAllKnowledgeTags,
  readKnowledgeMarkdown,
  searchKnowledgeNodesByTags,
} from "./knowledge-store.js";


const PER_NODE_MAX_CHARS = 8000;


/** 按对话中提及的标签采集知识库 markdown */
export async function collectKnowledgeByTags(
  prompt: string,
  sessionMessages: Array<{ role: string; content: string }> = [],
): Promise<{ chunks: CollectedChunk[]; query: string; userIntent: string; tags: string[] }> {
  const knownTags = await listAllKnowledgeTags();
  const tags = extractKnowledgeTagsFromDialogue(prompt, sessionMessages, knownTags);
  if (tags.length === 0) {
    return { chunks: [], query: prompt.trim(), userIntent: prompt.trim(), tags: [] };
  }
  const nodes = await searchKnowledgeNodesByTags(tags);
  const chunks: CollectedChunk[] = [];
  for (const node of nodes) {
    const markdown = (await readKnowledgeMarkdown(node.id)).trim();
    if (!markdown) {
      continue;
    }
    const tagLabel = (node.tags ?? []).join(", ");
    chunks.push({
      source: "knowledge",
      title: tagLabel ? `${node.name} [${tagLabel}]` : node.name,
      text: markdown.slice(0, PER_NODE_MAX_CHARS),
    });
  }
  return {
    chunks,
    query: tags.join("、"),
    userIntent: prompt.trim(),
    tags,
  };
}
