import { useEffect, useMemo, useState } from "react";
import type { AuthStatusResponse, CrewStatusResponse, HistorySessionSummary, LocalConfigResponse } from "@chatting-cursor/shared";
import {
  buildBridgeUrl,
  buildWebDevUrl,
  DEFAULT_BRIDGE_PORT,
  getWebPort,
  isLocalBridgeUrl,
  normalizeBridgeUrl,
  resetPortSettings,
  setWebPort,
} from "../bridgeSettings";
import { GITHUB_PAGES_URL, isGitHubPages } from "../environment";
import {
  fetchAuthStatus,
  fetchCrewStatus,
  fetchHistoryContent,
  fetchHistoryList,
  fetchLocalConfig,
  updateTokenDirectory,
  verifyBridgeToken,
} from "../api/bridge";


interface ConfigSubPageProps {
  bridgeUrl: string;
  bridgeToken: string;
  onBridgePortChange: (port: number) => void;
  onBridgeTokenChange: (token: string) => void;
  onBridgeUrlChange: (url: string) => void;
  onOpenCli: () => void;
}


function parsePortInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return null;
  }
  return parsed;
}


export function ConfigSubPage({
  bridgeUrl,
  bridgeToken,
  onBridgePortChange,
  onBridgeTokenChange,
  onBridgeUrlChange,
  onOpenCli,
}: ConfigSubPageProps) {
  const onGitHubPages = isGitHubPages();
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [localConfig, setLocalConfig] = useState<LocalConfigResponse | null>(null);
  const [crewStatus, setCrewStatus] = useState<CrewStatusResponse | null>(null);
  const [sessions, setSessions] = useState<HistorySessionSummary[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [historyContent, setHistoryContent] = useState("");
  const [historyFilter, setHistoryFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bridgeUrlInput, setBridgeUrlInput] = useState(bridgeUrl);
  const [tokenInput, setTokenInput] = useState(bridgeToken);
  const [tokenFileName, setTokenFileName] = useState("chattingcursor-token.txt");
  const [tokenDirectoryInput, setTokenDirectoryInput] = useState("");
  const [webPortInput, setWebPortInput] = useState(() => String(getWebPort()));
  const [savedWebPort, setSavedWebPort] = useState(() => getWebPort());
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const normalizedBridgeUrl = useMemo(() => normalizeBridgeUrl(bridgeUrl), [bridgeUrl]);
  const normalizedBridgeUrlInput = useMemo(() => normalizeBridgeUrl(bridgeUrlInput), [bridgeUrlInput]);
  const parsedWebPort = useMemo(() => parsePortInput(webPortInput), [webPortInput]);
  const canUseLocalApi = isLocalBridgeUrl(normalizedBridgeUrl);
  const hasInvalidInput = !normalizedBridgeUrlInput || (!onGitHubPages && parsedWebPort === null);
  const hasUnsavedChanges = bridgeUrlInput.trim() !== bridgeUrl
    || tokenInput.trim() !== bridgeToken
    || (!onGitHubPages && parsedWebPort !== null && parsedWebPort !== savedWebPort);
  const previewWebPort = parsedWebPort ?? savedWebPort;
  const filteredSessions = useMemo(() => {
    const keyword = historyFilter.trim().toLowerCase();
    if (!keyword) {
      return sessions;
    }
    return sessions.filter((session) => {
      return session.file.toLowerCase().includes(keyword)
        || session.sessionId.toLowerCase().includes(keyword);
    });
  }, [historyFilter, sessions]);


  useEffect(() => {
    setBridgeUrlInput(bridgeUrl);
  }, [bridgeUrl]);


  useEffect(() => {
    setTokenInput(bridgeToken);
  }, [bridgeToken]);


  useEffect(() => {
    if (!saveMessage) {
      return;
    }
    const timer = window.setTimeout(() => setSaveMessage(null), 4000);
    return () => window.clearTimeout(timer);
  }, [saveMessage]);


  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const auth = await fetchAuthStatus(normalizedBridgeUrl);
        if (cancelled) {
          return;
        }
        setAuthStatus(auth);
        if (!isLocalBridgeUrl(normalizedBridgeUrl)) {
          setLocalConfig(null);
          setCrewStatus(null);
          setSessions([]);
          setSelectedFile(null);
          setHistoryContent("");
          setLoading(false);
          return;
        }
        const [config, history, crew] = await Promise.all([
          fetchLocalConfig(normalizedBridgeUrl, bridgeToken),
          fetchHistoryList(normalizedBridgeUrl, bridgeToken),
          fetchCrewStatus(normalizedBridgeUrl, bridgeToken).catch(() => null),
        ]);
        if (cancelled) {
          return;
        }
        setLocalConfig(config);
        setTokenDirectoryInput(config.tokenFilePath.replace(new RegExp(`[\\\\/]${config.tokenFilePath.split(/[\\\\/]/).pop() ?? ""}$`), ""));
        setSessions(history.sessions);
        setCrewStatus(crew);
        setTokenFileName(config.tokenFilePath.split(/[\\/]/).pop() ?? "chattingcursor-token.txt");
      } catch (loadError) {
        if (!cancelled) {
          const message = loadError instanceof Error ? loadError.message : String(loadError);
          setError(`无法加载配置：${message}`);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    if (!normalizedBridgeUrl) {
      setLoading(false);
      setError("请先填写 Bridge URL。");
      return () => {
        cancelled = true;
      };
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [bridgeToken, normalizedBridgeUrl]);


  const handleSaveAndApply = async (): Promise<void> => {
    if (!normalizedBridgeUrlInput) {
      setSaveMessage("请输入有效的 Bridge URL。");
      return;
    }
    const remoteTarget = !isLocalBridgeUrl(normalizedBridgeUrlInput);
    if (remoteTarget && !tokenInput.trim()) {
      setSaveMessage("远程 Bridge 必须填写当天口令。");
      return;
    }
    if (!onGitHubPages && parsedWebPort === null) {
      setSaveMessage("网页端口无效，请输入 1–65535 之间的整数。");
      return;
    }
    if (tokenInput.trim()) {
      try {
        await verifyBridgeToken(normalizedBridgeUrlInput, tokenInput.trim());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSaveMessage(`口令验证失败：${message}`);
        return;
      }
    }
    onBridgeUrlChange(normalizedBridgeUrlInput);
    onBridgeTokenChange(tokenInput.trim());
    if (isLocalBridgeUrl(normalizedBridgeUrlInput)) {
      const port = (() => {
        try {
          return Number.parseInt(new URL(normalizedBridgeUrlInput).port || String(DEFAULT_BRIDGE_PORT), 10);
        } catch {
          return DEFAULT_BRIDGE_PORT;
        }
      })();
      onBridgePortChange(port);
    }
    if (!onGitHubPages && parsedWebPort !== null) {
      setWebPort(parsedWebPort);
      setSavedWebPort(parsedWebPort);
      setWebPortInput(String(parsedWebPort));
    }
    setSaveMessage("已保存并应用连接配置。");
  };


  const handleResetDefaults = (): void => {
    const defaults = resetPortSettings();
    onBridgePortChange(defaults.bridgePort);
    onBridgeUrlChange(buildBridgeUrl(defaults.bridgePort));
    onBridgeTokenChange("");
    setSavedWebPort(defaults.webPort);
    setBridgeUrlInput(buildBridgeUrl(defaults.bridgePort));
    setTokenInput("");
    setWebPortInput(String(defaults.webPort));
    setSaveMessage("已恢复默认连接配置。");
  };


  const handleSelectHistory = async (file: string): Promise<void> => {
    setSelectedFile(file);
    setHistoryContent("加载中…");
    try {
      const result = await fetchHistoryContent(normalizedBridgeUrl, file, bridgeToken);
      setHistoryContent(result.content);
    } catch (selectError) {
      const message = selectError instanceof Error ? selectError.message : String(selectError);
      setHistoryContent(`读取失败：${message}`);
    }
  };


  const handleApplyTokenDirectoryPath = async (): Promise<void> => {
    if (!tokenDirectoryInput.trim()) {
      setSaveMessage("请先输入完整目录路径。");
      return;
    }
    if (!canUseLocalApi) {
      setSaveMessage("只有本机 Bridge 才允许修改 token 同步目录。");
      return;
    }
    try {
      const result = await updateTokenDirectory(normalizedBridgeUrl, tokenDirectoryInput.trim(), bridgeToken);
      setTokenFileName(result.fileName);
      setTokenDirectoryInput(result.directory);
      setSaveMessage(`已切换到 ${result.directory}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSaveMessage(`设置目录失败：${message}`);
    }
  };


  return (
    <div className="config-sub-page">
      <section className="config-section">
        <h2>连接设置</h2>
        <div className="config-grid config-grid-form">
          <label className="config-field" htmlFor="bridge-url">
            <span className="config-field-label">Bridge URL</span>
            <input
              id="bridge-url"
              type="url"
              value={bridgeUrlInput}
              onChange={(event) => setBridgeUrlInput(event.target.value)}
              placeholder={onGitHubPages ? "https://bridge.example.com" : "http://127.0.0.1:4321"}
            />
          </label>
          {!onGitHubPages && (
            <label className="config-field" htmlFor="web-port">
              <span className="config-field-label">网页接收端口（Vite dev）</span>
              <input
                id="web-port"
                type="number"
                min={1}
                max={65535}
                value={webPortInput}
                onChange={(event) => setWebPortInput(event.target.value)}
              />
            </label>
          )}
          {onGitHubPages && (
            <div className="config-field config-field-readonly">
              <span className="config-field-label">网页地址（线上固定）</span>
              <p className="config-readonly-value">
                <code>{GITHUB_PAGES_URL}</code>
              </p>
            </div>
          )}
        </div>
        <div className="config-save-row">
          <p className={`config-save-status${hasUnsavedChanges ? " config-save-status-dirty" : ""}`} aria-live="polite">
            {hasInvalidInput
              ? "Bridge URL 或网页端口无效"
              : hasUnsavedChanges
                ? "有未保存的更改"
                : `已保存（${normalizedBridgeUrl || "未配置"}）`}
          </p>
          {saveMessage && <p className="config-save-toast" role="status">{saveMessage}</p>}
        </div>
        <div className="config-actions">
          <button
            type="button"
            className="btn-primary config-action-primary"
            onClick={() => void handleSaveAndApply()}
            disabled={hasInvalidInput || !hasUnsavedChanges}
          >
            保存并应用
          </button>
          <button
            type="button"
            className="btn-secondary config-action-secondary"
            onClick={handleResetDefaults}
          >
            恢复默认
          </button>
        </div>
        <p className="config-hint">
          手机访问 GitHub Pages 时，应填写公开的 Bridge 域名；电脑本机开发时，仍可填写 <code>{buildBridgeUrl(DEFAULT_BRIDGE_PORT)}</code>。
        </p>
        {!onGitHubPages && (
          <p className="config-hint">
            网页端口仅作本地开发参考；修改并保存后需重启 <code>pnpm dev:web</code>。当前参考地址：<code>{buildWebDevUrl(previewWebPort)}</code>
          </p>
        )}
      </section>

      <section className="config-section">
        <h2>每日口令</h2>
        {authStatus ? (
          <dl className="config-grid">
            <dt>当前日期</dt>
            <dd>{authStatus.tokenDate}</dd>
            <dt>远程入口</dt>
            <dd>{authStatus.publicBridgeUrl}</dd>
            <dt>固定文件名</dt>
            <dd>{tokenFileName}</dd>
            <dt>同步目录</dt>
            <dd>{tokenDirectoryInput ? `${tokenDirectoryInput}/${tokenFileName}` : "未配置"}</dd>
          </dl>
        ) : (
          <p className="config-hint">连接 Bridge 后会显示当天口令文件位置。</p>
        )}
        <label className="config-field" htmlFor="token-directory-path">
          <span className="config-field-label">同步目录路径</span>
          <input
            id="token-directory-path"
            type="text"
            value={tokenDirectoryInput}
            onChange={(event) => setTokenDirectoryInput(event.target.value)}
            placeholder="可手动粘贴完整路径，例如 D:\\Sync\\ChattingCursor"
          />
        </label>
        <div className="config-actions">
          <button
            type="button"
            className="btn-secondary config-action-secondary"
            onClick={() => void handleApplyTokenDirectoryPath()}
          >
            使用这个路径
          </button>
        </div>
        <p className="config-hint">
          页面不会显示 token 内容。请从同步文件里查看当天 token，并在需要时粘贴到聊天页；这里仅配置同步目录路径。Bridge 会把固定文件名 <code>{tokenFileName}</code> 写入该目录。
        </p>
      </section>

      {loading && <p className="config-hint">加载 Bridge 状态…</p>}
      {!loading && error && <p className="config-error">{error}</p>}

      {!loading && !error && localConfig && canUseLocalApi && (
        <>
          <section className="config-section">
            <h2>Bridge 与 CLI</h2>
            <dl className="config-grid">
              <dt>Bridge 地址</dt>
              <dd>{localConfig.bridgeUrl}</dd>
              <dt>公开地址</dt>
              <dd>{localConfig.publicBridgeUrl}</dd>
              <dt>默认模型</dt>
              <dd>{localConfig.defaultModel || "（未检测到）"}</dd>
              <dt>模型来源</dt>
              <dd>{localConfig.modelsSource === "cli" ? "cursor-agent models" : "内置回退列表"}</dd>
              <dt>CLI 命令</dt>
              <dd>{localConfig.cli.available ? (localConfig.cli.command ?? "可用") : (localConfig.cli.message ?? "不可用")}</dd>
              <dt>固定文件名</dt>
              <dd>{tokenFileName}</dd>
              <dt>口令日期</dt>
              <dd>{localConfig.tokenDate}</dd>
              <dt>历史目录</dt>
              <dd>{localConfig.historyDir}</dd>
              <dt>保留天数</dt>
              <dd>{localConfig.historyRetentionDays} 天</dd>
            </dl>
          </section>

          <section className="config-section">
            <h2>CLI 实时反馈</h2>
            <p className="config-hint">
              聊天页不显示 CLI 输出。请在<strong>单独终端</strong>运行以下命令，或切换到本页「CLI输出」查看最近一次 run 的原始 stdout/stderr。
            </p>
            <pre className="terminal-command">pnpm cli:watch</pre>
            <p className="config-hint">指定 runId：<code>pnpm cli:watch &lt;runId&gt;</code></p>
            <button type="button" className="btn-secondary config-link" onClick={onOpenCli}>
              打开 CLI 输出
            </button>
          </section>

          <section className="config-section">
            <h2>crewAI 编排</h2>
            {crewStatus ? (
              <dl className="config-grid">
                <dt>Python</dt>
                <dd>{crewStatus.python.available ? (crewStatus.python.command ?? "可用") : (crewStatus.python.message ?? "不可用")}</dd>
                <dt>crewAI</dt>
                <dd>{crewStatus.crewai.installed ? `已安装 (${crewStatus.crewai.version ?? "未知版本"})` : (crewStatus.crewai.message ?? "未安装")}</dd>
                <dt>Chrome 验证</dt>
                <dd>
                  {crewStatus.chrome.available
                    ? `${crewStatus.chrome.endpoint}（${crewStatus.chrome.pages ?? 0} 个页面）`
                    : (crewStatus.chrome.message ?? "未连接 9222")}
                </dd>
                <dt>示例配置</dt>
                <dd>{crewStatus.exampleConfig.valid ? crewStatus.exampleConfig.path : (crewStatus.exampleConfig.message ?? "无效")}</dd>
                <dt>运行方式</dt>
                <dd><code>pnpm crew:run</code>（dry-run）· <code>POST /crews/run</code></dd>
              </dl>
            ) : (
              <p className="config-hint">crewAI 状态不可用。</p>
            )}
          </section>
        </>
      )}

      <section className="config-section">
        <h2>历史文件查看</h2>
        <p className="config-hint">
          只有当 Bridge URL 指向当前电脑本机时，才允许查看本地历史全文与配置细节。远程手机场景下，这部分默认不开放。
        </p>
        {!canUseLocalApi && <p className="config-hint">当前 Bridge 不是本机地址，历史全文浏览已禁用。</p>}
        {canUseLocalApi && !loading && !error && sessions.length === 0 && (
          <p className="config-hint">暂无历史文件。完成至少一次 Agent 回复后会在此列出。</p>
        )}
        {canUseLocalApi && !loading && !error && sessions.length > 0 && (
          <>
            <label className="config-field history-filter" htmlFor="history-filter">
              <span className="config-field-label">筛选（文件名 / sessionId）</span>
              <input
                id="history-filter"
                type="search"
                value={historyFilter}
                onChange={(event) => setHistoryFilter(event.target.value)}
                placeholder="输入关键字…"
              />
            </label>
            <p className="config-hint">{filteredSessions.length} / {sessions.length} 个会话</p>
            <div className="history-browser">
              <ul className="history-list">
                {filteredSessions.map((session) => (
                  <li key={session.file}>
                    <button
                      type="button"
                      className={`history-item${selectedFile === session.file ? " history-item-active" : ""}`}
                      onClick={() => void handleSelectHistory(session.file)}
                    >
                      <span className="history-item-id">{session.file}</span>
                      <span className="history-item-meta">
                        {session.sessionId.slice(0, 8)}… · {new Date(session.modifiedAt).toLocaleString()} · {(session.sizeBytes / 1024).toFixed(1)} KB
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="history-viewer">
                {selectedFile ? (
                  <>
                    <h3>{selectedFile}</h3>
                    <pre>{historyContent}</pre>
                  </>
                ) : (
                  <p className="config-hint history-viewer-empty">从左侧选择文件以查看完整文本内容。</p>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
