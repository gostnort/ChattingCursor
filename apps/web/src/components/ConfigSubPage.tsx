import { useEffect, useMemo, useState } from "react";
import type { CrewStatusResponse, HistorySessionSummary, LocalConfigResponse } from "@chatting-cursor/shared";
import {
  buildWebDevUrl,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_WEB_PORT,
  getWebPort,
  resetPortSettings,
  setWebPort,
} from "../bridgeSettings";
import {
  fetchHistoryContent,
  fetchHistoryList,
  fetchLocalConfig,
  fetchCrewStatus,
  isLocalBridgeUrl,
} from "../api/bridge";


interface ConfigSubPageProps {
  bridgePort: number;
  bridgeUrl: string;
  onBridgePortChange: (port: number) => void;
  onOpenCli: () => void;
}


/** 校验端口输入 */
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


/** 本地 · 配置子页 */
export function ConfigSubPage({ bridgePort, bridgeUrl, onBridgePortChange, onOpenCli }: ConfigSubPageProps) {
  const [localConfig, setLocalConfig] = useState<LocalConfigResponse | null>(null);
  const [crewStatus, setCrewStatus] = useState<CrewStatusResponse | null>(null);
  const [sessions, setSessions] = useState<HistorySessionSummary[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [historyContent, setHistoryContent] = useState("");
  const [historyFilter, setHistoryFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bridgePortInput, setBridgePortInput] = useState(String(bridgePort));
  const [webPortInput, setWebPortInput] = useState(() => String(getWebPort()));
  const [savedWebPort, setSavedWebPort] = useState(() => getWebPort());
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const normalizedBridgeUrl = useMemo(() => bridgeUrl.replace(/\/$/, ""), [bridgeUrl]);
  const parsedBridgePort = useMemo(() => parsePortInput(bridgePortInput), [bridgePortInput]);
  const parsedWebPort = useMemo(() => parsePortInput(webPortInput), [webPortInput]);
  const hasInvalidInput = parsedBridgePort === null || parsedWebPort === null;
  const hasUnsavedChanges = !hasInvalidInput && (
    parsedBridgePort !== bridgePort || parsedWebPort !== savedWebPort
  );
  const previewWebPort = parsedWebPort ?? savedWebPort;
  const canUseLocalApi = isLocalBridgeUrl(normalizedBridgeUrl);
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
    setBridgePortInput(String(bridgePort));
  }, [bridgePort]);


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
      setLocalConfig(null);
      setCrewStatus(null);
      setSessions([]);
      setSelectedFile(null);
      setHistoryContent("");
      if (!canUseLocalApi) {
        setError("本地配置 API 仅在 Bridge 地址为 127.0.0.1 或 localhost 时可用。");
        setLoading(false);
        return;
      }
      try {
        const [config, history, crew] = await Promise.all([
          fetchLocalConfig(normalizedBridgeUrl),
          fetchHistoryList(normalizedBridgeUrl),
          fetchCrewStatus(normalizedBridgeUrl).catch(() => null),
        ]);
        if (cancelled) {
          return;
        }
        setLocalConfig(config);
        setSessions(history.sessions);
        setCrewStatus(crew);
      } catch (loadError) {
        if (!cancelled) {
          const message = loadError instanceof Error ? loadError.message : String(loadError);
          setError(`无法加载本地配置：${message}。请先运行 pnpm dev:bridge（端口 ${bridgePort}）。`);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [bridgePort, canUseLocalApi, normalizedBridgeUrl]);


  const handleSaveAndApply = (): void => {
    if (parsedBridgePort === null || parsedWebPort === null) {
      setSaveMessage("端口无效，请输入 1–65535 之间的整数。");
      return;
    }
    if (parsedBridgePort !== bridgePort) {
      onBridgePortChange(parsedBridgePort);
    }
    setWebPort(parsedWebPort);
    setSavedWebPort(parsedWebPort);
    setBridgePortInput(String(parsedBridgePort));
    setWebPortInput(String(parsedWebPort));
    setSaveMessage("已保存并应用。Bridge 进程需以相同端口启动后聊天才能连通。");
  };


  const handleResetDefaults = (): void => {
    const defaults = resetPortSettings();
    onBridgePortChange(defaults.bridgePort);
    setSavedWebPort(defaults.webPort);
    setBridgePortInput(String(defaults.bridgePort));
    setWebPortInput(String(defaults.webPort));
    setSaveMessage("已恢复默认（Bridge 3000，Web 5173）并应用。");
  };


  const handleSelectHistory = async (file: string): Promise<void> => {
    setSelectedFile(file);
    setHistoryContent("加载中…");
    try {
      const result = await fetchHistoryContent(normalizedBridgeUrl, file);
      setHistoryContent(result.content);
    } catch (selectError) {
      const message = selectError instanceof Error ? selectError.message : String(selectError);
      setHistoryContent(`读取失败：${message}`);
    }
  };


  return (
    <div className="config-sub-page">
      <section className="config-section">
        <h2>连接设置</h2>
        <div className="config-grid config-grid-form">
          <label className="config-field" htmlFor="bridge-port">
            <span className="config-field-label">本地接收端口（Bridge）</span>
            <input
              id="bridge-port"
              type="number"
              min={1}
              max={65535}
              value={bridgePortInput}
              onChange={(event) => setBridgePortInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  handleSaveAndApply();
                }
              }}
            />
          </label>
          <label className="config-field" htmlFor="web-port">
            <span className="config-field-label">网页接收端口（Vite dev）</span>
            <input
              id="web-port"
              type="number"
              min={1}
              max={65535}
              value={webPortInput}
              onChange={(event) => setWebPortInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  handleSaveAndApply();
                }
              }}
            />
          </label>
        </div>
        <div className="config-save-row">
          <p className={`config-save-status${hasUnsavedChanges ? " config-save-status-dirty" : ""}`} aria-live="polite">
            {hasInvalidInput
              ? "端口格式无效"
              : hasUnsavedChanges
                ? "有未保存的更改"
                : `已保存（Bridge ${bridgePort}，Web ${savedWebPort}）`}
          </p>
          {saveMessage && <p className="config-save-toast" role="status">{saveMessage}</p>}
        </div>
        <div className="config-actions">
          <button
            type="button"
            className="btn-primary config-action-primary"
            onClick={handleSaveAndApply}
            disabled={!hasUnsavedChanges || hasInvalidInput}
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
          默认端口：Bridge <code>{DEFAULT_BRIDGE_PORT}</code>，Web <code>{DEFAULT_WEB_PORT}</code>。首次打开使用默认值；若曾修改过，浏览器会记住上次保存的设置。
        </p>
        <p className="config-hint">
          聊天页通过 <code>{normalizedBridgeUrl}</code> 连接本机 Bridge。此处保存的是<strong>网页要连接的 Bridge 端口</strong>，保存后立即生效；Bridge 进程本身由环境变量 <code>BRIDGE_PORT</code> 决定监听端口（默认 {DEFAULT_BRIDGE_PORT}），需与此处一致，例如 <code>BRIDGE_PORT={parsedBridgePort ?? bridgePort} pnpm dev:bridge</code>。
        </p>
        <p className="config-hint">
          网页端口仅作本地开发参考；修改并保存后需<strong>重启</strong> <code>pnpm dev:web</code> 才会真正监听新端口。当前参考地址：<code>{buildWebDevUrl(previewWebPort)}</code>
        </p>
      </section>
      {loading && <p className="config-hint">加载 Bridge 状态…</p>}
      {!loading && error && <p className="config-error">{error}</p>}
      {!loading && !error && localConfig && (
        <>
          <section className="config-section">
            <h2>Bridge 与 CLI</h2>
            <dl className="config-grid">
              <dt>Bridge 地址</dt>
              <dd>{localConfig.bridgeUrl}</dd>
              <dt>默认模型</dt>
              <dd>{localConfig.defaultModel || "（未检测到）"}</dd>
              <dt>模型来源</dt>
              <dd>{localConfig.modelsSource === "cli" ? "cursor-agent models" : "内置回退列表"}</dd>
              <dt>CLI 命令</dt>
              <dd>{localConfig.cli.available ? (localConfig.cli.command ?? "可用") : (localConfig.cli.message ?? "不可用")}</dd>
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
                <dt>示例配置</dt>
                <dd>{crewStatus.exampleConfig.valid ? crewStatus.exampleConfig.path : (crewStatus.exampleConfig.message ?? "无效")}</dd>
                <dt>运行方式</dt>
                <dd><code>pnpm crew:run</code>（dry-run）· <code>POST /crews/run</code></dd>
              </dl>
            ) : (
              <p className="config-hint">crewAI 状态不可用。请确认 Bridge 已启动并安装 Python 依赖（见 QUICKSTART）。</p>
            )}
          </section>
        </>
      )}
      <section className="config-section">
        <h2>历史文件查看</h2>
        <p className="config-hint">
          浏览 <code>~/.chattingcursor/history/</code> 下的会话 JSON（通过 Bridge 只读代理）。
          {localConfig ? ` 文件位于 ${localConfig.historyDir}，超过 ${localConfig.historyRetentionDays} 天会自动删除。` : ""}
          聊天页仍可用自然语言搜索；此处为完整只读浏览。
        </p>
        {!canUseLocalApi && (
          <p className="config-hint">请将 Bridge 端口设为 {DEFAULT_BRIDGE_PORT} 并指向本机后再加载历史列表。</p>
        )}
        {canUseLocalApi && !loading && error && (
          <p className="config-hint">Bridge 未连接，无法列出历史文件。请先运行 <code>pnpm dev:bridge</code>。</p>
        )}
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
                  <p className="config-hint history-viewer-empty">从左侧选择文件以查看完整 JSON 内容。</p>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
