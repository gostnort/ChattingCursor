/** 从文本中匹配已知知识库标签（大小写不敏感，整词/子串） */
export function extractMentionedKnowledgeTags(
  text: string,
  knownTags: string[],
): string[] {
  const normalized = text.trim().toLowerCase();
  if (!normalized || knownTags.length === 0) {
    return [];
  }
  const matched: string[] = [];
  const seen = new Set<string>();
  const sorted = [...knownTags].sort((left, right) => right.length - left.length);
  for (const tag of sorted) {
    const key = tag.trim().toLowerCase();
    if (key.length < 2 || seen.has(key)) {
      continue;
    }
    if (normalized.includes(key)) {
      seen.add(key);
      matched.push(tag.trim());
    }
  }
  return matched;
}


/** 最近会话消息中是否提及知识库标签 */
export function extractKnowledgeTagsFromDialogue(
  prompt: string,
  sessionMessages: Array<{ role: string; content: string }>,
  knownTags: string[],
  recentTurns = 6,
): string[] {
  const parts = [prompt];
  const start = Math.max(0, sessionMessages.length - recentTurns);
  for (let index = start; index < sessionMessages.length; index += 1) {
    parts.push(sessionMessages[index].content);
  }
  const combined = parts.join("\n");
  return extractMentionedKnowledgeTags(combined, knownTags);
}


/** 是否应走知识库标签检索管线（非 /websearch、非历史回忆套话） */
export function shouldRunKnowledgeTagPipeline(
  prompt: string,
  knownTags: string[],
  sessionMessages: Array<{ role: string; content: string }>,
): boolean {
  const mentioned = extractKnowledgeTagsFromDialogue(prompt, sessionMessages, knownTags);
  return mentioned.length > 0;
}
