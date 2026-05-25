import type { LocalSub } from "../routing";
import { buildBridgeUrl } from "../bridgeSettings";
import { CliOutputSubPage } from "./CliOutputSubPage";
import { ConfigSubPage } from "./ConfigSubPage";


interface LocalViewProps {
  localSub: LocalSub;
  bridgePort: number;
  bridgeUrl: string;
  onBridgePortChange: (port: number) => void;
  onLocalSubChange: (sub: LocalSub) => void;
}


/** 本地模式根视图（仅含配置 / CLI 输出子导航） */
export function LocalView({
  localSub,
  bridgePort,
  bridgeUrl,
  onBridgePortChange,
  onLocalSubChange,
}: LocalViewProps) {
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
          className={localSub === "cli" ? "local-sub-active" : ""}
          aria-current={localSub === "cli" ? "page" : undefined}
          onClick={() => onLocalSubChange("cli")}
        >
          CLI输出
        </button>
      </nav>
      <main className="local-sub-main">
        {localSub === "config" ? (
          <div id="local-config" className="local-sub-panel config-page">
            <ConfigSubPage
              bridgePort={bridgePort}
              bridgeUrl={bridgeUrl}
              onBridgePortChange={onBridgePortChange}
              onOpenCli={() => onLocalSubChange("cli")}
            />
          </div>
        ) : (
          <div id="local-cli" className="local-sub-panel cli-page">
            <CliOutputSubPage bridgeUrl={buildBridgeUrl(bridgePort)} />
          </div>
        )}
      </main>
    </section>
  );
}
