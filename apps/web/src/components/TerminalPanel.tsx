import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "@chatting-cursor/shared";
import { subscribeTerminalEvents } from "../api/bridge";


interface TerminalPanelProps {
  bridgeUrl: string;
  bridgeToken: string;
  runId: string | null;
}


/** 展示 cursor-agent 子进程原始 stdout/stderr（非解析后的 SSE 事件） */
export function TerminalPanel({ bridgeUrl, bridgeToken, runId }: TerminalPanelProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [commandLine, setCommandLine] = useState<string>("");
  const [panelError, setPanelError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);


  useEffect(() => {
    if (!runId) {
      setLines([]);
      setCommandLine("");
      setPanelError(null);
      return;
    }
    setLines([]);
    setCommandLine("");
    setPanelError(null);
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
    }, (error) => {
      setPanelError(error.message);
    }, bridgeToken);
    return close;
  }, [bridgeToken, bridgeUrl, runId]);


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
        <p className="terminal-hint">在聊天页发送消息后，runId 会自动保存；切换到「本地 → CLI输出」可在此查看，或使用 <code>pnpm cli:watch</code> 在本地终端查看。</p>
      </section>
    );
  }


  return (
    <section className="terminal-panel">
      <h2>CLI 终端（原始输出）</h2>
      {panelError && <p className="config-error">CLI 输出不可用：{panelError}</p>}
      {commandLine && <pre className="terminal-command">{commandLine}</pre>}
      <pre ref={preRef} className="terminal-output">{lines.join("")}</pre>
    </section>
  );
}
