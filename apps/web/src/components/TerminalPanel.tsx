import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "@chatting-cursor/shared";
import { subscribeTerminalEvents } from "../api/bridge";


interface TerminalPanelProps {
  bridgeUrl: string;
  runId: string | null;
}


/** 展示 cursor-agent 子进程原始 stdout/stderr（非解析后的 SSE 事件） */
export function TerminalPanel({ bridgeUrl, runId }: TerminalPanelProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [commandLine, setCommandLine] = useState<string>("");
  const preRef = useRef<HTMLPreElement>(null);


  useEffect(() => {
    if (!runId) {
      setLines([]);
      setCommandLine("");
      return;
    }
    setLines([]);
    setCommandLine("");
    const close = subscribeTerminalEvents(bridgeUrl, runId, (event: RunEvent) => {
      if (event.type === "run_started") {
        const data = event.data as { command?: string; args?: string[]; prompt?: string } | undefined;
        const cmd = data?.command ?? "cursor-agent";
        const args = data?.args ?? [];
        const prompt = data?.prompt ?? "";
        setCommandLine(`$ ${cmd} ${args.join(" ")} "${prompt}"`);
        return;
      }
      if (event.type === "raw_stdout" && event.text) {
        setLines((prev) => [...prev, event.text ?? ""]);
        return;
      }
      if (event.type === "stderr" && event.text) {
        setLines((prev) => [...prev, event.text ?? ""]);
        return;
      }
      if (event.type === "run_finished") {
        const data = event.data as { exitCode?: number | null } | undefined;
        const code = data?.exitCode;
        setLines((prev) => [...prev, `\n[进程结束 exit=${code ?? "?"}]`]);
      }
    });
    return close;
  }, [bridgeUrl, runId]);


  useEffect(() => {
    const element = preRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lines]);


  if (!runId) {
    return (
      <section className="terminal-panel terminal-panel-idle">
        <h2>CLI 终端（原始输出）</h2>
        <p className="terminal-hint">发送消息后将在此显示 cursor-agent 子进程的真实 stdout/stderr。</p>
      </section>
    );
  }


  return (
    <section className="terminal-panel">
      <h2>CLI 终端（原始输出）</h2>
      {commandLine && <pre className="terminal-command">{commandLine}</pre>}
      <pre ref={preRef} className="terminal-output">{lines.join("")}</pre>
    </section>
  );
}
