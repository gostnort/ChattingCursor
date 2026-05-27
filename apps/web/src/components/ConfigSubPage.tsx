import { useEffect, useMemo, useState } from "react";
import type { AuthStatusResponse, CrewStatusResponse, HistorySessionSummary, LocalConfigResponse } from "@chatting-cursor/shared";
import type { AssistantBubbleColorKey, AssistantBubbleColors } from "../assistantBubbleSettings";
import { normalizeHexColor } from "../assistantBubbleSettings";
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
import { GITHUB_PAGES_URL, isGitHubPages, isLocalWebOrigin } from "../environment";
import { MAX_TEXT_SIZE_PX, MIN_TEXT_SIZE_PX } from "../textSizeSettings";
import {
  fetchAuthStatus,
  fetchCloudflareTunnelConfig,
  fetchCrewStatus,
  fetchHistoryContent,
  fetchHistoryList,
  fetchLocalConfig,
  fetchLocalTokenFile,
  saveCloudflareTunnelConfig,
  updateTokenDirectory,
  verifyBridgeToken,
} from "../api/bridge";
import {
  loadCloudflareTunnelSettings,
  saveCloudflareTunnelSettings,
  type CloudflareTunnelLocalSettings,
} from "../cloudflareTunnelSettings";
import { parseTodayTokenFromContent } from "../tokenFile";


interface ConfigSubPageProps {
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


function formatBridgeRequestError(bridgeUrl: string, onGitHubPages: boolean, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = normalizeBridgeUrl(bridgeUrl);
  const localTarget = isLocalBridgeUrl(normalized);
  const networkFailure = /failed to fetch|networkerror|network error|load failed|fetch resource/i.test(message);
  if (isLocalWebOrigin() && !localTarget && networkFailure) {
    return "你在本机浏览器打开页面，但 Bridge URL 指向远程地址。本地开发请改为 http://127.0.0.1:4321 并确认 Bridge 已启动；手机远程访问请改用 GitHub Pages 并粘贴 token 文件中的 publicBridgeUrl。";
  }
  if (onGitHubPages && localTarget && networkFailure) {
    return "当前 Bridge URL 仍是 127.0.0.1 / localhost。若你现在用的是手机，127.0.0.1 指向的是手机自己，不是电脑；GitHub Pages 也不会自动找到你的电脑。请先给电脑上的 Bridge 配置一个可公开访问的 HTTPS 地址，再把这个地址填到 Bridge URL。";
  }
  if (onGitHubPages && !localTarget && networkFailure) {
    return "远程 Bridge 当前不可达（隧道不可抵达）。请从云盘 token 文件复制最新的 publicBridgeUrl（须为 https://….trycloudflare.com），确认 run.bat 与 cloudflared 正在运行，并在本页保存后重试。";
  }
  if (isLocalWebOrigin() && localTarget && networkFailure) {
    return "无法连接本机 Bridge（http://127.0.0.1:4321）。请确认 run.bat / Bridge 已启动，且端口未被占用。";
  }
  return message;
}


export function ConfigSubPage({
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
  const [assistantBackgroundInput, setAssistantBackgroundInput] = useState(assistantBubbleColors.background);
  const [assistantTextInput, setAssistantTextInput] = useState(assistantBubbleColors.text);
  const [userBackgroundInput, setUserBackgroundInput] = useState(userBubbleBackground);
  const [cloudflareTunnel, setCloudflareTunnel] = useState<CloudflareTunnelLocalSettings>(() => loadCloudflareTunnelSettings());
  const [cloudflareConfigPath, setCloudflareConfigPath] = useState("");
  const [cloudflareNamedEnabled, setCloudflareNamedEnabled] = useState(false);
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
    setAssistantBackgroundInput(assistantBubbleColors.background);
    setAssistantTextInput(assistantBubbleColors.text);
  }, [assistantBubbleColors]);


  useEffect(() => {
    setUserBackgroundInput(userBubbleBackground);
  }, [userBubbleBackground]);


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
        const [config, history, crew, tokenFile, tunnelConfig] = await Promise.all([
          fetchLocalConfig(normalizedBridgeUrl, bridgeToken),
          fetchHistoryList(normalizedBridgeUrl, bridgeToken),
          fetchCrewStatus(normalizedBridgeUrl, bridgeToken).catch(() => null),
          fetchLocalTokenFile(normalizedBridgeUrl, bridgeToken).catch(() => null),
          fetchCloudflareTunnelConfig(normalizedBridgeUrl, bridgeToken).catch(() => null),
        ]);
        if (cancelled) {
          return;
        }
        setLocalConfig(config);
        setTokenDirectoryInput(config.tokenFilePath.replace(new RegExp(`[\\\\/]${config.tokenFilePath.split(/[\\\\/]/).pop() ?? ""}$`), ""));
        setSessions(history.sessions);
        setCrewStatus(crew);
        if (tunnelConfig) {
          const merged: CloudflareTunnelLocalSettings = {
            tunnelName: tunnelConfig.tunnelName?.trim() ?? "",
            accountId: tunnelConfig.accountId?.trim() ?? "",
            publicHostname: tunnelConfig.publicHostname?.trim() ?? "",
            credentialsFilePath: tunnelConfig.credentialsFilePath?.trim() ?? "",
            tunnelToken: tunnelConfig.tunnelToken?.trim() ?? "",
          };
          setCloudflareTunnel(merged);
          saveCloudflareTunnelSettings(merged);
          setCloudflareConfigPath(tunnelConfig.configPath);
          setCloudflareNamedEnabled(Boolean(tunnelConfig.namedTunnelEnabled));
        }
        setTokenFileName(config.tokenFilePath.split(/[\\/]/).pop() ?? "chattingcursor-token.txt");
        const fileToken = tokenFile ? parseTodayTokenFromContent(tokenFile.content) : "";
        if (fileToken && fileToken !== bridgeToken) {
          setTokenInput(fileToken);
          onBridgeTokenChange(fileToken);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(`无法加载配置：${formatBridgeRequestError(normalizedBridgeUrl, onGitHubPages, loadError)}`);
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
    if (onGitHubPages && remoteTarget) {
      try {
        const parsedUrl = new URL(normalizedBridgeUrlInput);
        if (parsedUrl.protocol !== "https:") {
          setSaveMessage("GitHub Pages 上的远程 Bridge URL 必须使用 https://；http:// 会被浏览器当作不安全请求拦截。");
          return;
        }
      } catch {
        setSaveMessage("请输入有效的 Bridge URL。");
        return;
      }
    }
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
        setSaveMessage(`口令验证失败：${formatBridgeRequestError(normalizedBridgeUrlInput, onGitHubPages, error)}`);
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
    onBridgeUrlChange(onGitHubPages ? "" : buildBridgeUrl(defaults.bridgePort));
    onBridgeTokenChange("");
    setSavedWebPort(defaults.webPort);
    setBridgeUrlInput(onGitHubPages ? "" : buildBridgeUrl(defaults.bridgePort));
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


  const handleSaveCloudflareTunnel = async (): Promise<void> => {
    if (!canUseLocalApi) {
      setSaveMessage("Named tunnel settings require a local Bridge connection.");
      return;
    }
    saveCloudflareTunnelSettings(cloudflareTunnel);
    try {
      const result = await saveCloudflareTunnelConfig(normalizedBridgeUrl, cloudflareTunnel, bridgeToken);
      setCloudflareConfigPath(result.configPath);
      setCloudflareNamedEnabled(Boolean(result.namedTunnelEnabled));
      setSaveMessage(
        result.namedTunnelEnabled
          ? `Saved. run.bat will use cloudflared tunnel run (${cloudflareTunnel.tunnelName}). Restart run.bat to apply.`
          : "Saved (quick tunnel remains default until tunnel name and hostname are both set).",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSaveMessage(`Saved in browser only; Bridge write failed: ${message}`);
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


  const handleUserBubbleBackgroundChange = (value: string): void => {
    const normalized = normalizeHexColor(value);
    if (!normalized) {
      return;
    }
    onUserBubbleBackgroundChange(normalized);
  };


  const handleUserBubbleBackgroundBlur = (value: string): void => {
    const normalized = normalizeHexColor(value);
    if (normalized) {
      setUserBackgroundInput(normalized);
      return;
    }
    setUserBackgroundInput(userBubbleBackground);
  };


  const handleAssistantBubbleColorChange = (key: AssistantBubbleColorKey, value: string): void => {
    const normalized = normalizeHexColor(value);
    if (!normalized) {
      return;
    }
    onAssistantBubbleColorsChange({
      ...assistantBubbleColors,
      [key]: normalized,
    });
  };


  const handleAssistantBubbleColorBlur = (
    key: AssistantBubbleColorKey,
    value: string,
    setValue: (next: string) => void,
  ): void => {
    const normalized = normalizeHexColor(value);
    if (normalized) {
      setValue(normalized);
      return;
    }
    setValue(assistantBubbleColors[key]);
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
          <label className="config-field" htmlFor="bridge-token">
            <span className="config-field-label">当天口令（远程访问时填写）</span>
            <input
              id="bridge-token"
              type="text"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              placeholder="访问远程 Bridge / GitHub Pages 时，粘贴当天 token"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {!onGitHubPages && (
            <label className="config-field" htmlFor="web-port">
              <span className="config-field-label">网页接收端口（Vite dev）</span>
              <input
                id="web-port"
                className="config-input-compact"
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
        <h2>文字大小</h2>
        <label className="config-field" htmlFor="text-size-slider">
          <span className="config-field-label">当前字号</span>
          <input
            id="text-size-slider"
            type="range"
            min={MIN_TEXT_SIZE_PX}
            max={MAX_TEXT_SIZE_PX}
            step={1}
            value={textSizePx}
            onChange={(event) => onTextSizeChange(Number.parseInt(event.target.value, 10))}
          />
        </label>
        <p className="config-hint">
          当前 {textSizePx}px。该设置会立即作用于聊天输入框和对话气泡文字，并保存在浏览器本地。
        </p>
      </section>

      <section className="config-section">
        <h2>气泡颜色</h2>
        <p className="config-hint">
          下面的十六进制文本框会立即保存到浏览器本地。用户内容底色同时决定 assistant 气泡边框色；assistant 背景色与文字色可单独调整。
        </p>
        <div className="assistant-color-grid">
          <label className="config-field assistant-color-row" htmlFor="user-bubble-background">
            <span className="config-field-label">用户内容底色</span>
            <div className="assistant-color-inputs">
              <input
                id="user-bubble-background"
                type="text"
                inputMode="text"
                value={userBackgroundInput}
                onChange={(event) => {
                  setUserBackgroundInput(event.target.value);
                  handleUserBubbleBackgroundChange(event.target.value);
                }}
                onBlur={() => handleUserBubbleBackgroundBlur(userBackgroundInput)}
                placeholder="#238636"
                spellCheck={false}
              />
              <input
                className="config-color-picker"
                type="color"
                aria-label="选择用户内容底色"
                value={userBubbleBackground}
                onChange={(event) => {
                  setUserBackgroundInput(event.target.value);
                  handleUserBubbleBackgroundChange(event.target.value);
                }}
              />
            </div>
          </label>
          <label className="config-field assistant-color-row" htmlFor="assistant-bubble-background">
            <span className="config-field-label">assistant 背景色</span>
            <div className="assistant-color-inputs">
              <input
                id="assistant-bubble-background"
                type="text"
                inputMode="text"
                value={assistantBackgroundInput}
                onChange={(event) => {
                  setAssistantBackgroundInput(event.target.value);
                  handleAssistantBubbleColorChange("background", event.target.value);
                }}
                onBlur={() => handleAssistantBubbleColorBlur("background", assistantBackgroundInput, setAssistantBackgroundInput)}
                placeholder="#0d1117"
                spellCheck={false}
              />
              <input
                className="config-color-picker"
                type="color"
                aria-label="选择 assistant 背景色"
                value={assistantBubbleColors.background}
                onChange={(event) => {
                  setAssistantBackgroundInput(event.target.value);
                  handleAssistantBubbleColorChange("background", event.target.value);
                }}
              />
            </div>
          </label>
          <label className="config-field assistant-color-row" htmlFor="assistant-bubble-text">
            <span className="config-field-label">assistant 文字色</span>
            <div className="assistant-color-inputs">
              <input
                id="assistant-bubble-text"
                type="text"
                inputMode="text"
                value={assistantTextInput}
                onChange={(event) => {
                  setAssistantTextInput(event.target.value);
                  handleAssistantBubbleColorChange("text", event.target.value);
                }}
                onBlur={() => handleAssistantBubbleColorBlur("text", assistantTextInput, setAssistantTextInput)}
                placeholder="#f8fafc"
                spellCheck={false}
              />
              <input
                className="config-color-picker"
                type="color"
                aria-label="选择 assistant 文字色"
                value={assistantBubbleColors.text}
                onChange={(event) => {
                  setAssistantTextInput(event.target.value);
                  handleAssistantBubbleColorChange("text", event.target.value);
                }}
              />
            </div>
          </label>
        </div>
        <div className="bubble-color-preview" aria-live="polite">
          <div className="user-bubble-preview-bubble">
            用户预览气泡
          </div>
          <div
            className="assistant-bubble-preview-bubble"
            style={{
              background: assistantBubbleColors.background,
              color: assistantBubbleColors.text,
            }}
          >
            Assistant 预览气泡
          </div>
        </div>
      </section>

      {canUseLocalApi && (
        <section className="config-section">
          <h2>Cloudflare tunnel (optional — named tunnel)</h2>
          <p className="config-hint">
            Stored locally in your browser and on this PC at{" "}
            <code>{cloudflareConfigPath || "%USERPROFILE%\\.chattingcursor\\cloudflare-tunnel.json"}</code>.
            Leave blank to keep the default quick tunnel (<code>trycloudflare.com</code>) from run.bat.
          </p>
          <div className="config-grid config-grid-form">
            <label className="config-field" htmlFor="cf-tunnel-name">
              <span className="config-field-label">Tunnel name</span>
              <input
                id="cf-tunnel-name"
                type="text"
                value={cloudflareTunnel.tunnelName}
                onChange={(event) => setCloudflareTunnel({ ...cloudflareTunnel, tunnelName: event.target.value })}
                placeholder="chattingcursor-bridge"
                spellCheck={false}
              />
              <span className="config-hint">Matches the name in your Cloudflare tunnel and config.yml.</span>
            </label>
            <label className="config-field" htmlFor="cf-public-hostname">
              <span className="config-field-label">Public hostname</span>
              <input
                id="cf-public-hostname"
                type="text"
                value={cloudflareTunnel.publicHostname}
                onChange={(event) => setCloudflareTunnel({ ...cloudflareTunnel, publicHostname: event.target.value })}
                placeholder="bridge.example.com"
                spellCheck={false}
              />
              <span className="config-hint">Stable HTTPS host routed to Bridge (no https:// prefix needed).</span>
            </label>
            <label className="config-field" htmlFor="cf-account-id">
              <span className="config-field-label">Cloudflare account ID (optional)</span>
              <input
                id="cf-account-id"
                type="text"
                value={cloudflareTunnel.accountId}
                onChange={(event) => setCloudflareTunnel({ ...cloudflareTunnel, accountId: event.target.value })}
                placeholder="For your reference only"
                spellCheck={false}
              />
              <span className="config-hint">Not required by run.bat; helps you find the right dashboard account.</span>
            </label>
            <label className="config-field" htmlFor="cf-credentials-path">
              <span className="config-field-label">Credentials JSON path (optional)</span>
              <input
                id="cf-credentials-path"
                type="text"
                value={cloudflareTunnel.credentialsFilePath}
                onChange={(event) => setCloudflareTunnel({ ...cloudflareTunnel, credentialsFilePath: event.target.value })}
                placeholder="%USERPROFILE%\\.cloudflared\\&lt;tunnel-id&gt;.json"
                spellCheck={false}
              />
              <span className="config-hint">From cloudflared tunnel create; usually referenced in config.yml.</span>
            </label>
            <label className="config-field" htmlFor="cf-tunnel-token">
              <span className="config-field-label">Tunnel token (optional)</span>
              <input
                id="cf-tunnel-token"
                type="password"
                value={cloudflareTunnel.tunnelToken}
                onChange={(event) => setCloudflareTunnel({ ...cloudflareTunnel, tunnelToken: event.target.value })}
                placeholder="Only if you run via tunnel token instead of config.yml"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="config-hint">Stored locally only; run.bat uses tunnel name + your existing config.yml.</span>
            </label>
          </div>
          <div className="config-actions">
            <button
              type="button"
              className="btn-secondary config-action-secondary"
              onClick={() => void handleSaveCloudflareTunnel()}
            >
              Save Cloudflare tunnel settings
            </button>
          </div>
          {cloudflareNamedEnabled && (
            <p className="config-hint">
              Named tunnel is active for this PC. Restart run.bat to switch from quick tunnel.
            </p>
          )}
        </section>
      )}

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
            placeholder="默认 %USERPROFILE%\\.chattingcursor，或云盘同步目录"
          />
        </label>
        <div className="config-actions token-directory-actions">
          <button
            type="button"
            className="btn-secondary config-action-secondary token-directory-action"
            onClick={() => void handleApplyTokenDirectoryPath()}
          >
            使用这个路径
          </button>
        </div>
        <p className="config-hint">
          默认与历史记录同在 <code>%USERPROFILE%\.chattingcursor</code>；远程访问时可改为云盘目录并点「使用这个路径」持久化。Bridge 会写入固定文件名 <code>{tokenFileName}</code>。
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
            <p className="config-hint">
              联网搜索默认走本机 Chrome（端口 9222），无需 Kimi 付费 API。聊天框使用{" "}
              <code>/websearch 关键词</code>、<code>/google 关键词</code> 或「网上搜一下…」；
              本地历史用 <code>/search 关键词</code> 或自然语言查找近 7 天记录。
              <code>run.bat</code> 会在检测到本机 <code>cursor-agent</code> 时优先使用 native，否则尝试 WSL。
            </p>
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
