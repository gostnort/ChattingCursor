import { readFile } from "node:fs/promises";
import { v4 as uuidv4 } from "uuid";
import { Agent, CursorAgentError } from "@cursor/sdk";
import { formatPathForCli, mergeAssistantStreamText, probeCursorCli, runCursorCli } from "@chatting-cursor/cli-client";
import { wrapCursorCliPrompt } from "./cli-conversation-guard.js";
import { buildImageAnalysisPrompt } from "./image-analysis-prompt.js";
import type { SessionMessage } from "./session-store.js";


const DEFAULT_ANALYSIS_MODEL = "composer-2";


/** 从 SDK 运行结果或会话轮次中提取助手文本 */
function extractSdkAnalysisText(resultText: string | undefined, conversationText: string): string {
  const fromResult = resultText?.trim() ?? "";
  if (fromResult) {
    return fromResult;
  }
  return conversationText.trim();
}


/** 从 conversation 轮次拼接助手回复 */
function extractConversationAssistantText(turns: Array<{ role?: string; content?: string }>): string {
  const parts: string[] = [];
  for (const turn of turns) {
    if (turn.role === "assistant" && turn.content?.trim()) {
      parts.push(turn.content.trim());
    }
  }
  return parts.join("\n\n");
}


/** 使用 Cursor SDK 多模态分析图片 */
async function analyzeWithSdk(
  absolutePath: string,
  mimeType: string,
  messages: SessionMessage[],
  cwd: string,
): Promise<string> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("CURSOR_API_KEY is not set");
  }
  const modelId = process.env.CURSOR_IMAGE_ANALYSIS_MODEL?.trim() || DEFAULT_ANALYSIS_MODEL;
  const buffer = await readFile(absolutePath);
  const data = buffer.toString("base64");
  const contextBlock = messages.slice(-12).map((message) => {
    const roleLabel = message.role === "user" ? "User" : "Assistant";
    const text = message.content.trim() || "(empty)";
    return `${roleLabel}: ${text}`;
  }).join("\n");
  const promptText = [
    "Describe this image in detail for a software development chat.",
    "Include visible UI, text, code, errors, diagrams, and anything actionable.",
    contextBlock ? `\nConversation context:\n${contextBlock}` : "",
  ].filter(Boolean).join("\n");
  const agent = await Agent.create({
    apiKey,
    model: { id: modelId },
    local: { cwd },
  });
  try {
    const run = await agent.send({
      text: promptText,
      images: [{ data, mimeType }],
    });
    const result = await run.wait();
    if (result.status === "error") {
      throw new Error("Image analysis agent run failed");
    }
    let conversationText = "";
    if (run.supports("conversation")) {
      const turns = await run.conversation();
      conversationText = extractConversationAssistantText(
        turns as Array<{ role?: string; content?: string }>,
      );
    }
    const text = extractSdkAnalysisText(result.result, conversationText);
    if (!text) {
      throw new Error("Image analysis returned empty text");
    }
    return text;
  } catch (error) {
    if (error instanceof CursorAgentError) {
      throw new Error(`Image analysis failed: ${error.message}`);
    }
    throw error;
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}


/** 使用 cursor-agent CLI 分析图片（无 API Key 时的回退） */
async function analyzeWithCli(
  absolutePath: string,
  fileName: string,
  messages: SessionMessage[],
  model?: string,
  workspace?: string,
): Promise<string> {
  const cli = await probeCursorCli();
  if (!cli.available) {
    throw new Error(cli.message ?? "Cursor Agent CLI is not available");
  }
  const viaWsl = cli.command === "wsl";
  const imageCliPath = formatPathForCli(absolutePath, viaWsl);
  const prompt = buildImageAnalysisPrompt(messages, imageCliPath, fileName);
  const userContext = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const runId = uuidv4();
  let assistantText = "";
  await runCursorCli({
    runId,
    prompt: wrapCursorCliPrompt(`${userContext}\n\n${prompt}`),
    model,
    workspace,
    onEvent: (event) => {
      if (event.type === "assistant" && event.text) {
        assistantText = mergeAssistantStreamText(assistantText, event.text);
      }
      if (event.type === "result" && event.text) {
        assistantText = event.text;
      }
    },
  });
  const text = assistantText.trim();
  if (!text) {
    throw new Error("CLI image analysis returned empty text");
  }
  return text;
}


/** 分析已上传图片；优先 SDK，否则回退 CLI */
export async function analyzeUploadedImage(options: {
  absolutePath: string;
  mimeType: string;
  fileName: string;
  messages: SessionMessage[];
  model?: string;
  workspace?: string;
}): Promise<string> {
  const cwd = options.workspace?.trim() || process.cwd();
  if (process.env.CURSOR_API_KEY?.trim()) {
    try {
      return await analyzeWithSdk(
        options.absolutePath,
        options.mimeType,
        options.messages,
        cwd,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (process.env.CURSOR_IMAGE_ANALYSIS_FORCE_SDK === "1") {
        throw error;
      }
      console.warn(`SDK image analysis failed, falling back to CLI: ${message}`);
    }
  }
  return analyzeWithCli(
    options.absolutePath,
    options.fileName,
    options.messages,
    options.model,
    options.workspace,
  );
}


const FORWARD_CONTEXT_MAX_MESSAGES = 12;


/** 取最近对话上下文：优先自上次助手回复之后，否则取末尾 N 条 */
function collectRecentConversationContext(
  messages: SessionMessage[],
  userIntent?: string,
): { contextLines: string[]; userIntentLine?: string } {
  const trimmed = messages.filter((message) => message.content.trim());
  const lastAssistantIndex = trimmed.map((message) => message.role).lastIndexOf("assistant");
  let slice = lastAssistantIndex >= 0
    ? trimmed.slice(lastAssistantIndex + 1)
    : trimmed.slice(-FORWARD_CONTEXT_MAX_MESSAGES);
  if (slice.length > FORWARD_CONTEXT_MAX_MESSAGES) {
    slice = slice.slice(-FORWARD_CONTEXT_MAX_MESSAGES);
  }
  const contextLines = slice.map((message) => {
    const roleLabel = message.role === "user" ? "User" : "Assistant";
    return `${roleLabel}: ${message.content.trim()}`;
  });
  const intent = userIntent?.trim() ?? "";
  let userIntentLine: string | undefined;
  if (intent) {
    const lastUser = [...trimmed].reverse().find((message) => message.role === "user");
    if (!lastUser || lastUser.content.trim() !== intent) {
      userIntentLine = intent;
    }
  }
  return { contextLines, userIntentLine };
}


/** 组装转发给 agent-cli 的完整提示（会话上下文 + 图片分析） */
export function buildImageForwardPrompt(
  analysisText: string,
  fileName: string,
  messages: SessionMessage[],
  userIntent?: string,
): string {
  const { contextLines, userIntentLine } = collectRecentConversationContext(messages, userIntent);
  const parts: string[] = [];
  const contextParts: string[] = [...contextLines];
  if (userIntentLine) {
    contextParts.push(`User (current message): ${userIntentLine}`);
  }
  if (contextParts.length > 0) {
    parts.push("[User context]", ...contextParts, "");
  }
  parts.push(
    "[Image analysis]",
    analysisText,
    "",
    `(User attached image: ${fileName})`,
  );
  return parts.join("\n");
}
