import { mergeAssistantStreamText } from "@chatting-cursor/cli-client";
import type { RunEvent } from "@chatting-cursor/shared";


/** 从 run 事件中提取最终 assistant 文本 */
export function extractAssistantText(events: RunEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "assistant" && event.text) {
      text = mergeAssistantStreamText(text, event.text);
    }
    if (event.type === "result" && event.text) {
      text = event.text;
    }
  }
  return text;
}
