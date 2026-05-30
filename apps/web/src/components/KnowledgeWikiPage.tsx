import { useMemo } from "react";
import { isLocalBridgeUrl, normalizeBridgeUrl } from "../bridgeSettings";
import { KnowledgeWikiSection } from "./KnowledgeWikiSection";


interface KnowledgeWikiPageProps {
  bridgeUrl: string;
  bridgeToken: string;
}


/** 本地 · 知识库子页（仅本机 Bridge） */
export function KnowledgeWikiPage({ bridgeUrl, bridgeToken }: KnowledgeWikiPageProps) {
  const normalizedBridgeUrl = useMemo(() => normalizeBridgeUrl(bridgeUrl), [bridgeUrl]);
  const canUseLocalApi = isLocalBridgeUrl(normalizedBridgeUrl);
  return (
    <div id="local-knowledge" className="local-sub-panel knowledge-page">
      <header className="knowledge-page-header">
        <h2>知识库</h2>
        <p className="config-hint">
          树形 wiki 供所有离线模型注入上下文。在节点上右键或长按可创建子节点、上传 .md、重命名或删除（根节点不可删）。
        </p>
      </header>
      {!canUseLocalApi ? (
        <p className="config-hint">
          当前 Bridge 不是本机地址，知识库管理已禁用。请先在「配置」中将 Bridge URL 设为 <code>http://127.0.0.1:4321</code> 等本机地址。
        </p>
      ) : (
        <KnowledgeWikiSection bridgeUrl={normalizedBridgeUrl} bridgeToken={bridgeToken} />
      )}
    </div>
  );
}
