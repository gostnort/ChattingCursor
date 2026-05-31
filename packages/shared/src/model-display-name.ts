import { sortAlphaDescNumeric } from "./alpha-desc-numeric-sort.js";
import { LOCAL_LLM_MODEL_ID_PREFIX } from "./offline-models.js";


/** 合并作者列表并按 registry 同款规则排序（去重） */
export function buildModelDisplayAuthorList(authors: Iterable<string>): string[] {
  const unique = [...new Set([...authors].map((item) => item.trim()).filter(Boolean))];
  return sortAlphaDescNumeric(unique, (item) => item);
}


/** 从 local-llm/{author}/{slug} id 提取作者名 */
export function extractLocalLlmAuthorFromModelId(modelId: string): string | null {
  if (!modelId.startsWith(LOCAL_LLM_MODEL_ID_PREFIX)) {
    return null;
  }
  const rest = modelId.slice(LOCAL_LLM_MODEL_ID_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) {
    return null;
  }
  return rest.slice(0, slash);
}


/** 从模型 id 列表收集作者并排序 */
export function buildModelDisplayAuthorListFromModelIds(modelIds: Iterable<string>): string[] {
  const authors: string[] = [];
  for (const modelId of modelIds) {
    const author = extractLocalLlmAuthorFromModelId(modelId);
    if (author) {
      authors.push(author);
    }
  }
  return buildModelDisplayAuthorList(authors);
}


/** 作者名超过 6 字符时用 DOS 8.3 风格缩短（如 bartowski → bart~1） */
export function formatAuthorDisplayName(author: string, allAuthors?: readonly string[]): string {
  const trimmed = author.trim();
  if (trimmed.length <= 6) {
    return trimmed;
  }
  if (!allAuthors || allAuthors.length === 0) {
    return `${trimmed.slice(0, 4)}~1`;
  }
  const sortedAuthors = buildModelDisplayAuthorList(allAuthors);
  const idx = sortedAuthors.indexOf(trimmed);
  const slot = idx >= 0 ? idx + 1 : sortedAuthors.length + 1;
  return `${trimmed.slice(0, 4)}~${slot}`;
}


/** 模型 slug 展示：保留开头连续字母数字前缀，遇非 [A-Za-z0-9] 即截断 */
export function formatModelSlugDisplayName(modelSlug: string): string {
  const trimmed = modelSlug.trim();
  if (!trimmed) {
    return trimmed;
  }
  const match = trimmed.match(/^[A-Za-z0-9]+/);
  return match?.[0] ?? trimmed;
}


/** 下拉框展示：完整 author/modelSlug，不做 DOS 缩短 */
export function formatModelDropdownLabel(author: string, modelSlug: string): string {
  const authorTrimmed = author.trim();
  const slugTrimmed = modelSlug.trim();
  if (!authorTrimmed) {
    return slugTrimmed;
  }
  if (!slugTrimmed) {
    return authorTrimmed;
  }
  return `${authorTrimmed}/${slugTrimmed}`;
}


/** 从 local-llm/{author}/{slug} id 生成下拉框标签 */
export function formatModelDropdownLabelFromId(modelId: string): string {
  if (!modelId.startsWith(LOCAL_LLM_MODEL_ID_PREFIX)) {
    return modelId;
  }
  const rest = modelId.slice(LOCAL_LLM_MODEL_ID_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) {
    return rest;
  }
  return formatModelDropdownLabel(rest.slice(0, slash), rest.slice(slash + 1));
}


/** 气泡 pill 展示：DOS 缩短作者 + model slug 前缀截断 */
export function formatModelDisplayName(
  author: string,
  modelSlug: string,
  allAuthors?: readonly string[],
): string {
  return `${formatAuthorDisplayName(author, allAuthors)}/${formatModelSlugDisplayName(modelSlug)}`;
}


/** 从 local-llm/{author}/{slug} id 生成展示标签 */
export function formatModelDisplayLabelFromId(modelId: string, allAuthors?: readonly string[]): string {
  if (!modelId.startsWith(LOCAL_LLM_MODEL_ID_PREFIX)) {
    return modelId;
  }
  const rest = modelId.slice(LOCAL_LLM_MODEL_ID_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) {
    return rest;
  }
  return formatModelDisplayName(rest.slice(0, slash), rest.slice(slash + 1), allAuthors);
}


/** 从 author/slug 或 local-llm id 标签解析并格式化 */
export function formatModelDisplayLabel(labelOrId: string, allAuthors?: readonly string[]): string {
  const trimmed = labelOrId.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith(LOCAL_LLM_MODEL_ID_PREFIX)) {
    return formatModelDisplayLabelFromId(trimmed, allAuthors);
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    return formatModelDisplayName(trimmed.slice(0, slash), trimmed.slice(slash + 1), allAuthors);
  }
  return trimmed;
}
