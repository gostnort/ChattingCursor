import { useMemo, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:3000";

/** 应用根组件 */
export default function App() {
  const [bridgeUrl, setBridgeUrl] = useState(() => {
    return localStorage.getItem("bridgeUrl") ?? DEFAULT_BRIDGE_URL;
  });
  const normalizedBridgeUrl = useMemo(() => bridgeUrl.replace(/\/$/, ""), [bridgeUrl]);

  const handleBridgeUrlChange = (value: string): void => {
    setBridgeUrl(value);
    localStorage.setItem("bridgeUrl", value);
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>ChattingCursor</h1>
        <p>Local-first：请先在本机启动 Bridge，再通过 CLI 与 Cursor Agent 通信。</p>
        <label className="bridge-config">
          Bridge URL
          <input
            value={bridgeUrl}
            onChange={(event) => handleBridgeUrlChange(event.target.value)}
            placeholder={DEFAULT_BRIDGE_URL}
          />
        </label>
      </header>
      <main>
        <ChatPanel bridgeUrl={normalizedBridgeUrl} />
      </main>
    </div>
  );
}
