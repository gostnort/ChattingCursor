import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchPilotTtsInstallStatus,
  fetchSchedulerSettings,
  fetchTtsStatus,
  repairPilotTtsInstall,
  saveSchedulerSettings,
  startPilotTts,
  startPilotTtsInstall,
  startPilotTtsWebui,
  stopPilotTtsWebui,
  stopPilotTts,
} from "../api/bridge";
import { formatBridgeFetchError, normalizeBridgeUrl } from "../bridgeSettings";


interface TtsSubPageProps {
  bridgeUrl: string;
}


function friendlyTtsMessage(bridgeUrl: string, raw: string | undefined): string | null {
  if (!raw?.trim()) {
    return null;
  }
  const msg = raw.trim();
  if (/fetch failed|failed to fetch|networkerror|load failed/i.test(msg)) {
    return formatBridgeFetchError(bridgeUrl, new Error(msg));
  }
  if (/ECONNREFUSED|aborted|timeout|无响应/i.test(msg)) {
    return "朗读 API（4323）未响应；若已勾选「启用朗读 API」请稍候，或检查 Bridge 是否运行。";
  }
  return msg.replace(/\bsidecar\b/gi, "朗读 API");
}


function installStatusLabel(input: {
  installPhase?: string;
  upstreamInstalled: boolean;
  weightsReady: boolean;
  installBusy: boolean;
}): string {
  if (input.installBusy) {
    return "安装进行中…";
  }
  if (input.installPhase === "partial" || (!input.upstreamInstalled && input.weightsReady)) {
    return "依赖未完整（缺少上游代码）";
  }
  if (input.installPhase === "needs_weights" || (input.upstreamInstalled && !input.weightsReady)) {
    return "依赖未完整（缺少权重）";
  }
  if (input.installPhase === "missing" || !input.upstreamInstalled) {
    return "未安装";
  }
  return "已安装";
}


/** 本地语音子页：安装、启用朗读 API（4323）、打开 Pilot 配置（8090 WebUI） */
export function TtsSubPage({ bridgeUrl }: TtsSubPageProps) {
  const normalizedBridgeUrl = useMemo(() => normalizeBridgeUrl(bridgeUrl), [bridgeUrl]);
  const [upstreamInstalled, setUpstreamInstalled] = useState(false);
  const [installPresent, setInstallPresent] = useState(false);
  const [needsRepair, setNeedsRepair] = useState(true);
  const [installPhase, setInstallPhase] = useState<string>("missing");
  const [apiRunning, setApiRunning] = useState(false);
  const [apiEnabledPref, setApiEnabledPref] = useState(false);
  const [weightsReady, setWeightsReady] = useState(false);
  const [gpuLoaded, setGpuLoaded] = useState(false);
  const [gpuWarming, setGpuWarming] = useState(false);
  const [webUiActive, setWebUiActive] = useState(false);
  const [webUiUrl, setWebUiUrl] = useState("");
  const [healthHint, setHealthHint] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [bridgeReachable, setBridgeReachable] = useState<boolean | null>(null);
  const [apiToggleBusy, setApiToggleBusy] = useState(false);
  const [apiStartProgress, setApiStartProgress] = useState<string | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const statusFailCountRef = useRef(0);
  const formatError = useCallback(
    (err: unknown): string => formatBridgeFetchError(normalizedBridgeUrl, err),
    [normalizedBridgeUrl],
  );
  const applyTtsStatus = useCallback((tts: Awaited<ReturnType<typeof fetchTtsStatus>>) => {
    setUpstreamInstalled(tts.upstreamInstalled);
    setInstallPresent(tts.installPresent);
    setNeedsRepair(tts.needsRepair ?? (!tts.upstreamInstalled || !tts.weightsReady));
    setInstallPhase(tts.installPhase ?? "missing");
    setWeightsReady(tts.weightsReady);
    setGpuLoaded(tts.gpuLoaded);
    setGpuWarming(Boolean(tts.gpuWarming));
    setApiRunning(tts.sidecarActive && (tts.gpuLoaded || Boolean(tts.gpuWarming)));
    setWebUiActive(tts.webUiActive);
    setWebUiUrl(tts.webUiUrl);
    const hint = tts.loadError ?? tts.healthMessage;
    setHealthHint(friendlyTtsMessage(normalizedBridgeUrl, hint));
  }, [normalizedBridgeUrl]);
  const resetTtsStatus = useCallback((): void => {
    setUpstreamInstalled(false);
    setInstallPresent(false);
    setNeedsRepair(true);
    setInstallPhase("missing");
    setWeightsReady(false);
    setGpuLoaded(false);
    setGpuWarming(false);
    setApiRunning(false);
    setWebUiActive(false);
    setHealthHint(null);
  }, []);
  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const tts = await fetchTtsStatus(normalizedBridgeUrl);
      statusFailCountRef.current = 0;
      setBridgeReachable(true);
      setPageError(null);
      applyTtsStatus(tts);
    } catch (err: unknown) {
      statusFailCountRef.current += 1;
      setBridgeReachable(false);
      setPageError(formatError(err));
      if (statusFailCountRef.current >= 2) {
        resetTtsStatus();
      }
    }
  }, [normalizedBridgeUrl, formatError, applyTtsStatus, resetTtsStatus]);
  const loadApiPreference = useCallback(async (): Promise<void> => {
    try {
      const bundle = await fetchSchedulerSettings(normalizedBridgeUrl);
      setApiEnabledPref(bundle.settings.pilotTtsApiEnabled);
    } catch {
      // 偏好读取失败时保持默认 false
    }
  }, [normalizedBridgeUrl]);
  useEffect(() => {
    void loadApiPreference();
    void refreshStatus();
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [loadApiPreference, refreshStatus]);
  useEffect(() => {
    if (bridgeReachable !== false) {
      return;
    }
    const retryTimer = window.setInterval(() => {
      void refreshStatus();
    }, 4000);
    return () => window.clearInterval(retryTimer);
  }, [bridgeReachable, refreshStatus]);
  const pollInstall = async (jobId: string): Promise<void> => {
    const deadline = Date.now() + 3_600_000;
    while (Date.now() < deadline) {
      const status = await fetchPilotTtsInstallStatus(normalizedBridgeUrl, jobId);
      setInstallProgress(status.progress || "安装进行中…");
      if (status.state === "done") {
        setInstallProgress("安装完成。可勾选「启用朗读 API」，或使用「打开 Pilot 配置」调参。");
        await refreshStatus();
        return;
      }
      if (status.state === "error") {
        setInstallError(status.error ?? status.progress ?? "安装失败");
        setInstallProgress(null);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    setInstallError("安装超时，请查看 pilot_tts/.install-logs 后重试。");
    setInstallProgress(null);
  };
  const handleInstall = (reset: boolean = false): void => {
    setInstallBusy(true);
    setInstallError(null);
    setInstallProgress(reset ? "正在重置并安装 PilotTTS…" : "正在安装 PilotTTS（上游代码、依赖与语音权重）…");
    void startPilotTtsInstall(normalizedBridgeUrl, { reset })
      .then(({ jobId }) => pollInstall(jobId))
      .catch((err: unknown) => {
        setInstallError(formatError(err));
        setInstallProgress(null);
      })
      .finally(() => setInstallBusy(false));
  };
  const handleRepairInstall = (): void => {
    setInstallBusy(true);
    setInstallError(null);
    setInstallProgress("正在修复 PilotTTS 安装（补全上游代码与权重）…");
    void repairPilotTtsInstall(normalizedBridgeUrl)
      .then(({ jobId }) => pollInstall(jobId))
      .catch((err: unknown) => {
        setInstallError(formatError(err));
        setInstallProgress(null);
      })
      .finally(() => setInstallBusy(false));
  };
  const openConfigInBrowser = (url: string): void => {
    const target = url.trim();
    if (!target) {
      return;
    }
    window.open(target, "_blank", "noopener,noreferrer");
  };
  const handleOpenPilotConfig = (): void => {
    setConfigError(null);
    if (!upstreamInstalled) {
      handleRepairInstall();
      return;
    }
    if (webUiActive && webUiUrl.trim()) {
      openConfigInBrowser(webUiUrl);
      return;
    }
    setConfigBusy(true);
    
    // 同步打开新窗口以避免被浏览器拦截
    const htmlContent = "<html lang='zh'><body style='font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #1e1e1e; color: #fff; text-align: center;'><h2>PilotTTS 配置界面启动中，请稍候...<br><br><span style='font-size: 16px; color: #aaa;'>Starting PilotTTS WebUI, please wait...</span></h2></body></html>";
    const newWindow = window.open("data:text/html;charset=utf-8," + encodeURIComponent(htmlContent), "_blank", "noopener,noreferrer");

    void startPilotTtsWebui(normalizedBridgeUrl)
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.message ?? "Pilot 配置界面未能启动");
        }
        const url = result.webUiUrl?.trim() || webUiUrl;
        return refreshStatus().then(() => {
          if (newWindow) {
            newWindow.location.href = url;
          } else {
            openConfigInBrowser(url);
          }
        });
      })
      .catch((err: unknown) => {
        if (newWindow) {
          newWindow.close();
        }
        setConfigError(formatError(err));
        void refreshStatus();
      })
      .finally(() => setConfigBusy(false));
  };
  const handleClosePilotConfig = (): void => {
    setConfigError(null);
    setConfigBusy(true);
    void stopPilotTtsWebui(normalizedBridgeUrl)
      .then(() => refreshStatus())
      .catch((err: unknown) => {
        setConfigError(formatError(err));
        void refreshStatus();
      })
      .finally(() => setConfigBusy(false));
  };
  const persistApiEnabled = async (enabled: boolean): Promise<void> => {
    const result = await saveSchedulerSettings(normalizedBridgeUrl, { pilotTtsApiEnabled: enabled });
    setApiEnabledPref(result.settings.pilotTtsApiEnabled);
  };
  const handleApiToggle = (enabled: boolean): void => {
    setApiToggleBusy(true);
    setPageError(null);
    setApiStartProgress(null);
    setApiEnabledPref(enabled);
    if (!enabled) {
      void persistApiEnabled(false)
        .then(() => stopPilotTts(normalizedBridgeUrl))
        .then(() => refreshStatus())
        .catch((err: unknown) => {
          setPageError(formatError(err));
          void refreshStatus();
        })
        .finally(() => setApiToggleBusy(false));
      return;
    }
    setApiStartProgress("正在启动朗读 API（4323）…");
    void persistApiEnabled(true)
      .then(() => startPilotTts(normalizedBridgeUrl))
      .then(async (result) => {
        if (!result.ok) {
          throw new Error(result.message ?? "朗读 API 未能启动");
        }
        if (result.warming) {
          setApiStartProgress("朗读 API 已启动，GPU 加载中（后台进行，可继续使用应用）…");
        }
        await refreshStatus();
      })
      .catch((err: unknown) => {
        setPageError(formatError(err));
        void loadApiPreference();
        void refreshStatus();
      })
      .finally(() => {
        setApiStartProgress(null);
        setApiToggleBusy(false);
      });
  };
  const busy = installBusy || apiToggleBusy;
  const installLabel = installStatusLabel({
    installPhase,
    upstreamInstalled,
    weightsReady,
    installBusy,
  });
  const canEnableApi = upstreamInstalled && weightsReady && bridgeReachable !== false;
  const serviceLabel = apiRunning
    ? gpuWarming && !gpuLoaded
      ? "朗读 API 运行中（GPU 加载中）"
      : "朗读 API 运行中"
    : apiStartProgress || (apiToggleBusy && apiEnabledPref)
      ? "朗读 API 启动中"
      : apiEnabledPref && weightsReady && upstreamInstalled
        ? "朗读 API 已启用（等待就绪）"
        : "朗读 API 未运行";
  const configUiStatus = configError
    ? `配置界面：${configError}`
    : configBusy
      ? "配置界面启动中…"
      : webUiActive
        ? "配置界面（8090）运行中"
        : upstreamInstalled
          ? "配置界面（8090）未启动"
          : "配置界面：需先完成 PilotTTS 安装";
  const installButtonLabel = upstreamInstalled || installPresent
    ? "修复 / 补全安装"
    : "安装 PilotTTS";
  return (
    <div className="local-sub-panel tts-page">
      <div className="local-models-page-header tts-page-header">
        <h2>语音</h2>
        <label className="local-models-page-vision-toggle">
          <input
            type="checkbox"
            checked={apiEnabledPref}
            onChange={(event) => handleApiToggle(event.target.checked)}
            disabled={busy || !canEnableApi}
            title={
              canEnableApi
                ? undefined
                : !upstreamInstalled
                  ? "请先完成 PilotTTS 安装（含上游代码）"
                  : !weightsReady
                    ? "请先下载语音权重"
                    : "无法连接 Bridge"
            }
          />
          启用朗读 API
        </label>
      </div>
      <p className="config-hint">
        全应用朗读优先使用本机 PilotTTS（4323）；未就绪时回退浏览器朗读。调参请用「打开 Pilot 配置」（8090 Gradio），与朗读 API 无关。
      </p>
      {pageError && (
        <p className="config-error" role="alert">{pageError}</p>
      )}
      {apiStartProgress && (
        <div className="local-install-progress" role="status" aria-live="polite">
          <progress className="local-install-progress-bar" max={100} />
          <p className="config-save-toast local-install-progress-text">{apiStartProgress}</p>
        </div>
      )}
      <ul className="tts-status-list" aria-live="polite">
        <li>{installLabel}</li>
        <li>{serviceLabel}</li>
        <li>{weightsReady ? "权重已就绪" : "权重未就绪"}</li>
        <li>{gpuLoaded ? "GPU 已加载" : gpuWarming ? "GPU 加载中" : "GPU 未加载"}</li>
        <li>{configUiStatus}</li>
      </ul>
      {healthHint && !pageError && <p className="config-hint">{healthHint}</p>}
      {installProgress && (
        <div className="local-install-progress" role="status" aria-live="polite">
          {installBusy && <progress className="local-install-progress-bar" max={100} />}
          <p className="config-save-toast local-install-progress-text">{installProgress}</p>
        </div>
      )}
      {installError && <p className="config-error" role="alert">{installError}</p>}
      {!installBusy && (
        <div className="local-models-row" style={{ display: "flex", gap: "8px" }}>
          {needsRepair && (
            <button
              type="button"
              className="btn-primary local-models-btn"
              disabled={busy || bridgeReachable === false}
              onClick={() => handleInstall(false)}
            >
              {installButtonLabel}
            </button>
          )}
          {(upstreamInstalled || installPresent) && (
            <button
              type="button"
              className="btn-secondary local-models-btn"
              disabled={busy || bridgeReachable === false}
              onClick={() => {
                if (window.confirm("确定要重置并重新安装 PilotTTS 吗？这会删除现有的虚拟环境和上游代码。")) {
                  handleInstall(true);
                }
              }}
            >
              重置并重新安装
            </button>
          )}
          {!needsRepair && !(upstreamInstalled || installPresent) && (
            <button
              type="button"
              className="btn-primary local-models-btn"
              disabled={busy || bridgeReachable === false}
              onClick={() => handleInstall(false)}
            >
              安装 PilotTTS
            </button>
          )}
        </div>
      )}
      <div className="tts-config-actions">
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            type="button"
            className="btn-primary tts-config-btn"
            disabled={configBusy || bridgeReachable === false}
            title={
              upstreamInstalled
                ? undefined
                : "将启动修复安装以补全上游代码"
            }
            onClick={handleOpenPilotConfig}
          >
            {configBusy
              ? "正在打开…"
              : upstreamInstalled
                ? "打开 Pilot 配置"
                : "打开 Pilot 配置（需安装）"}
          </button>
          {webUiActive && (
            <button
              type="button"
              className="btn-secondary tts-config-btn"
              disabled={configBusy || bridgeReachable === false}
              onClick={handleClosePilotConfig}
            >
              关闭 Pilot 配置
            </button>
          )}
        </div>
        {needsRepair && !installBusy && (
          <p className="tts-config-hint config-hint">
            {upstreamInstalled
              ? "权重或 GPU 未就绪时可点击上方按钮修复安装。"
              : "仓库自带朗读 API 脚本，但 GitHub 上游（webui.py）尚未就绪；请运行 install.bat 或点击「安装 PilotTTS」。"}
          </p>
        )}
      </div>
    </div>
  );
}
