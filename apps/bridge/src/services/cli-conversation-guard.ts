const PROJECT_NAME_PATTERN = /chatting\s*cursor|chatting-cursor/i;
const PROJECT_TOPIC_PATTERN = /(?:本|此|该|这个|当前)\s*(?:项目|仓库|代码库|repo)|(?:项目|仓库|代码库)\s*(?:里|中|的)?(?:修改|变更|diff)|workspace\s*变更/i;


/** 用户是否明确在问本仓库 / ChattingCursor */
export function userMentionedThisProject(userPrompt: string): boolean {
  const trimmed = userPrompt.trim();
  if (!trimmed) {
    return false;
  }
  if (PROJECT_NAME_PATTERN.test(trimmed)) {
    return true;
  }
  if (PROJECT_TOPIC_PATTERN.test(trimmed)) {
    return true;
  }
  return false;
}


/** 为 cursor-agent 注入对话约束：未问本项目时不主动谈仓库改动 */
export function wrapCursorCliPrompt(userPrompt: string): string {
  if (userMentionedThisProject(userPrompt)) {
    return userPrompt;
  }
  const guard = [
    "【系统约束】用户未询问 ChattingCursor 本仓库/本项目时：",
    "不要在回复中主动描述或讨论对本项目的代码修改、工作区文件变更或 git 状态；",
    "只回答用户的问题本身。若用户之后明确问到本项目，再可讨论。",
    "",
    "【用户消息】",
    userPrompt,
  ].join("\n");
  return guard;
}
