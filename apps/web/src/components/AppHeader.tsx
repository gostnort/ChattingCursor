import type { AppMode } from "../routing";


interface AppHeaderProps {
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
}


/** 聊天模式图标 */
function ChatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1.5 2.75A1.25 1.25 0 0 1 2.75 1.5h10.5a1.25 1.25 0 0 1 1.25 1.25v6.5A1.25 1.25 0 0 1 13.25 10.5H5.5L2 13.5V10.5H2.75A1.25 1.25 0 0 1 1.5 9.25v-6.5Z" />
    </svg>
  );
}


/** 本地模式图标 */
function LocalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2 3.25A1.25 1.25 0 0 1 3.25 2h9.5A1.25 1.25 0 0 1 14 3.25v9.5A1.25 1.25 0 0 1 12.75 14H3.25A1.25 1.25 0 0 1 2 12.75v-9.5ZM4 5.5v1h8v-1H4Zm0 2.5v1h5.5v-1H4Z" />
    </svg>
  );
}


/** 应用顶栏：标题 + 聊天/本地模式切换 */
export function AppHeader({ mode, onModeChange }: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="app-title-row">
        <div className="app-title-group">
          <h1>ChattingCursor</h1>
          <div className="mode-switch" role="tablist" aria-label="应用模式">
            <button
              type="button"
              role="tab"
              aria-label="聊天"
              aria-selected={mode === "chat"}
              title="聊天"
              className={mode === "chat" ? "mode-switch-active" : ""}
              onClick={() => onModeChange("chat")}
            >
              <ChatIcon />
            </button>
            <button
              type="button"
              role="tab"
              aria-label="本地"
              aria-selected={mode === "local"}
              title="本地"
              className={mode === "local" ? "mode-switch-active" : ""}
              onClick={() => onModeChange("local")}
            >
              <LocalIcon />
            </button>
          </div>
        </div>
      </div>
      {mode === "chat" ? (
        <p className="app-tagline">与 Cursor Agent 对话。</p>
      ) : (
        <p className="app-tagline">本机 Bridge 配置、历史浏览与 CLI 原始输出。</p>
      )}
    </header>
  );
}
