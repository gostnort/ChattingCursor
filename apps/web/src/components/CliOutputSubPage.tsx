import { useEffect, useMemo, useState } from "react";
import { TerminalPanel } from "./TerminalPanel";


const LATEST_RUN_ID_KEY = "latestRunId";


interface CliOutputSubPageProps {
  bridgeUrl: string;
  bridgeToken: string;
}


/** 本地 · CLI 输出子页 */
export function CliOutputSubPage({ bridgeUrl, bridgeToken }: CliOutputSubPageProps) {
  const [runId, setRunId] = useState("");
  const normalizedBridgeUrl = useMemo(() => bridgeUrl.replace(/\/$/, ""), [bridgeUrl]);


  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const queryRunId = params.get("runId")?.trim() ?? "";
    const storedRunId = localStorage.getItem(LATEST_RUN_ID_KEY)?.trim() ?? "";
    setRunId(queryRunId || storedRunId);
  }, []);


  const handleRunIdChange = (value: string): void => {
    setRunId(value);
    if (value.trim()) {
      localStorage.setItem(LATEST_RUN_ID_KEY, value.trim());
    }
  };


  return (
    <div className="cli-sub-page">
      <p className="config-hint">
        Bridge 地址：<code>{normalizedBridgeUrl}</code>（在「配置」页修改本地接收端口）
      </p>
      <label className="bridge-config">
        Run ID
        <input
          value={runId}
          onChange={(event) => handleRunIdChange(event.target.value)}
          placeholder="发送聊天后自动填入，或粘贴 runId"
        />
      </label>
      <section className="config-section terminal-page-hint">
        <h2>本地实时反馈（推荐）</h2>
        <p className="config-hint">
          在单独终端运行 <code>pnpm cli:watch</code>（可选 runId 参数），直接在 PowerShell 中查看 Bridge 转发的 CLI 原始输出。
        </p>
        <pre className="terminal-command">pnpm cli:watch</pre>
        <p className="config-hint">指定 runId：<code>pnpm cli:watch &lt;runId&gt;</code></p>
      </section>
      <TerminalPanel bridgeUrl={normalizedBridgeUrl} bridgeToken={bridgeToken} runId={runId.trim() || null} />
    </div>
  );
}
