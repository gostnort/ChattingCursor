#!/usr/bin/env node
/** 在本地终端订阅 Bridge 的 CLI 原始输出 SSE */
import process from "node:process";
import { execFile } from "node:child_process";


const DEFAULT_BRIDGE_URL = "http://127.0.0.1:4321";
const bridgeUrl = (process.env.BRIDGE_URL ?? DEFAULT_BRIDGE_URL).replace(/\/$/, "");
const bridgeToken = process.env.BRIDGE_TOKEN?.trim() ?? "";
const runId = process.argv[2]?.trim() ?? process.env.RUN_ID?.trim() ?? "";


function playExitNotificationSound() {
  if (process.platform === "win32") {
    execFile(
      "powershell",
      ["-NoProfile", "-Command", "[System.Media.SystemSounds]::Asterisk.Play()"],
      { windowsHide: true },
      () => {},
    );
    return;
  }
  process.stdout.write("\u0007");
}


function printUsage() {
  console.log("用法: pnpm cli:watch [runId]");
  console.log("");
  console.log("在单独终端查看 cursor-agent 原始 stdout/stderr（Bridge SSE）。");
  console.log("聊天页发送消息后 runId 会写入浏览器 localStorage；也可从 Bridge 日志或聊天响应中获取。");
  console.log("");
  console.log(`Bridge URL: ${bridgeUrl}`);
  console.log(`Bridge Token: ${bridgeToken ? "已设置" : "未设置"}`);
  console.log("环境变量: BRIDGE_URL, BRIDGE_TOKEN, RUN_ID");
  console.log("");
  console.log("或在浏览器打开: http://127.0.0.1:43210/ChattingCursor/terminal");
}


if (!runId) {
  printUsage();
  process.exit(1);
}


console.log(`订阅终端 SSE: ${bridgeUrl}/chat/terminal/${runId}`);
console.log("---");


const response = await fetch(`${bridgeUrl}/chat/terminal/${runId}`, {
  headers: {
    Accept: "text/event-stream",
    ...(bridgeToken ? { Authorization: `Bearer ${bridgeToken}` } : {}),
  },
});


if (!response.ok || !response.body) {
  console.error(`连接失败 (${response.status})，请确认 Bridge 已启动且 runId 正确。`);
  process.exit(1);
}


const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of response.body) {
  buffer += decoder.decode(chunk, { stream: true });
  const parts = buffer.split("\n\n");
  buffer = parts.pop() ?? "";
  for (const part of parts) {
    const dataLine = part.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) {
      continue;
    }
    try {
      const event = JSON.parse(dataLine.slice(5).trim());
      if (event.type === "run_started" && event.data) {
        const cmd = event.data.command ?? "cursor-agent";
        const args = Array.isArray(event.data.args) ? event.data.args.join(" ") : "";
        const prompt = event.data.prompt ?? "";
        console.log(`$ ${cmd} ${args} "${prompt}"`);
        continue;
      }
      if ((event.type === "raw_stdout" || event.type === "stderr") && event.text) {
        process.stdout.write(event.text);
        continue;
      }
      if (event.type === "run_finished") {
        const code = event.data?.exitCode;
        console.log(`\n[进程结束 exit=${code ?? "?"}]`);
        playExitNotificationSound();
      }
    } catch {
      // 忽略无法解析的 SSE 块
    }
  }
}
