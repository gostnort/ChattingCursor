import type { SessionMessage } from "./session-store.js";


/** 将对话历史格式化为 CLI 提示词中的上下文块 */
function formatConversationContext(messages: SessionMessage[], maxTurns = 12): string {
  const recent = messages.slice(-maxTurns);
  if (recent.length === 0) {
    return "（暂无先前对话，请仅根据图片内容作答。）";
  }
  return recent.map((message) => {
    const roleLabel = message.role === "user" ? "用户" : "助手";
    const text = message.content.trim() || "（无文字，可能为图片消息）";
    return `${roleLabel}: ${text}`;
  }).join("\n");
}


/** 根据会话上下文与图片路径构建 Cursor CLI 分析提示词 */
export function buildImageAnalysisPrompt(
  messages: SessionMessage[],
  imageCliPath: string,
  fileName: string,
): string {
  const context = formatConversationContext(messages);
  return [
    "请结合以下对话上下文，分析用户刚上传的图片，并给出与当前讨论相关的说明与建议。",
    "",
    "【对话上下文】",
    context,
    "",
    "【待分析图片】",
    `文件名：${fileName}`,
    `路径：${imageCliPath}`,
    "",
    "请直接阅读并分析该图片文件，描述可见内容，并回答上下文中隐含或明确的问题。",
  ].join("\n");
}
