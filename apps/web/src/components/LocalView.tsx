import { useMemo } from "react";
import type { AssistantBubbleColors } from "../assistantBubbleSettings";
import { normalizeBridgeUrl } from "../bridgeSettings";
import type { LocalSub } from "../routing";
import { CliOutputSubPage } from "./CliOutputSubPage";
import { ConfigSubPage } from "./ConfigSubPage";
import { KnowledgeWikiPage } from "./KnowledgeWikiPage";
import { LocalModelsSubPage } from "./LocalModelsSubPage";


interface LocalViewProps {
  localSub: LocalSub;
  assistantBubbleColors: AssistantBubbleColors;
  userBubbleBackground: string;
  bridgeUrl: string;
  bridgeToken: string;
  textSizePx: number;
  onAssistantBubbleColorsChange: (colors: AssistantBubbleColors) => void;
  onUserBubbleBackgroundChange: (color: string) => void;
  onBridgePortChange: (port: number) => void;
  onBridgeTokenChange: (token: string) => void;
  onBridgeUrlChange: (url: string) => void;
  onTextSizeChange: (size: number) => void;
  onLocalSubChange: (sub: LocalSub) => void;
}


/** 本地模式根视图（配置 / 知识库 / CLI 输出子导航） */
export function LocalView({
  localSub,
  assistantBubbleColors,
  userBubbleBackground,
  bridgeUrl,
  bridgeToken,
  textSizePx,
  onAssistantBubbleColorsChange,
  onUserBubbleBackgroundChange,
  onBridgePortChange,
  onBridgeTokenChange,
  onBridgeUrlChange,
  onTextSizeChange,
  onLocalSubChange,
}: LocalViewProps) {
  const normalizedBridgeUrl = useMemo(() => normalizeBridgeUrl(bridgeUrl), [bridgeUrl]);
  return (
    <section id="local-view" className="app-view local-view" aria-label="本地">
      <nav className="local-sub-nav" aria-label="本地子页">
        <button
          type="button"
          className={localSub === "config" ? "local-sub-active" : ""}
          aria-current={localSub === "config" ? "page" : undefined}
          onClick={() => onLocalSubChange("config")}
        >
          配置
        </button>
        <button
          type="button"
          className={localSub === "knowledge" ? "local-sub-active" : ""}
          aria-current={localSub === "knowledge" ? "page" : undefined}
          onClick={() => onLocalSubChange("knowledge")}
        >
          知识库
        </button>
        <button
          type="button"
          className={localSub === "models" ? "local-sub-active" : ""}
          aria-current={localSub === "models" ? "page" : undefined}
          onClick={() => onLocalSubChange("models")}
        >
          本地模型
        </button>
        <button
          type="button"
          className={localSub === "cli" ? "local-sub-active" : ""}
          aria-current={localSub === "cli" ? "page" : undefined}
          onClick={() => onLocalSubChange("cli")}
        >
          CLI输出
        </button>
      </nav>
      <main className={`local-sub-main${localSub === "knowledge" ? " local-sub-main-knowledge" : ""}`}>
        {localSub === "config" && (
          <div id="local-config" className="local-sub-panel config-page">
            <ConfigSubPage
              assistantBubbleColors={assistantBubbleColors}
              userBubbleBackground={userBubbleBackground}
              bridgeUrl={normalizedBridgeUrl}
              bridgeToken={bridgeToken}
              textSizePx={textSizePx}
              onAssistantBubbleColorsChange={onAssistantBubbleColorsChange}
              onUserBubbleBackgroundChange={onUserBubbleBackgroundChange}
              onBridgePortChange={onBridgePortChange}
              onBridgeTokenChange={onBridgeTokenChange}
              onBridgeUrlChange={onBridgeUrlChange}
              onTextSizeChange={onTextSizeChange}
              onOpenCli={() => onLocalSubChange("cli")}
              onOpenKnowledge={() => onLocalSubChange("knowledge")}
            />
          </div>
        )}
        {localSub === "knowledge" && (
          <KnowledgeWikiPage bridgeUrl={normalizedBridgeUrl} bridgeToken={bridgeToken} />
        )}
        {localSub === "models" && (
          <LocalModelsSubPage bridgeUrl={normalizedBridgeUrl} />
        )}
        {localSub === "cli" && (
          <div id="local-cli" className="local-sub-panel cli-page">
            <CliOutputSubPage bridgeUrl={normalizedBridgeUrl} bridgeToken={bridgeToken} />
          </div>
        )}
      </main>
    </section>
  );
}
