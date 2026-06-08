import { useCallback, useEffect, useMemo, useState } from "react";
import { sortAlphaDescNumeric } from "@chatting-cursor/shared";
import {
  addLocalVlmAuthor,
  deleteLocalVlmModel,
  fetchLocalVlmAuthors,
  fetchLocalVlmHfFiles,
  fetchLocalVlmHfModels,
  fetchLocalVlmInstallStatus,
  fetchOfflineVisionSettings,
  installLocalVlmModel,
  patchOfflineVisionSettings,
  type GgufGroupOption,
  type HfModelSummary,
} from "../api/bridge";
import { formatBridgeFetchError, normalizeBridgeUrl } from "../bridgeSettings";


function hfAuthorFromRepoId(repoId: string): string {
  const slash = repoId.indexOf("/");
  if (slash <= 0) {
    return repoId.trim();
  }
  return repoId.slice(0, slash).trim();
}


interface LocalVisionModelsSectionProps {
  bridgeUrl: string;
  defaultOfflineVlmRepo: string;
}


/** 视觉模型下载与管理（独立 local_vlm 目录，含 mmproj） */
export function LocalVisionModelsSection({ bridgeUrl, defaultOfflineVlmRepo }: LocalVisionModelsSectionProps) {
  const normalizedBridgeUrl = useMemo(() => normalizeBridgeUrl(bridgeUrl), [bridgeUrl]);
  const defaultRepoId = useMemo(
    () => defaultOfflineVlmRepo.trim() || "Rizwan313/Qwen3-VL-Embedding-2B-GGUF",
    [defaultOfflineVlmRepo],
  );
  const defaultAuthor = useMemo(() => hfAuthorFromRepoId(defaultRepoId), [defaultRepoId]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [installed, setInstalled] = useState<Array<{ id: string; label: string; repoId: string; weightsReady: boolean }>>([]);
  const [authors, setAuthors] = useState<string[]>([]);
  const [selectedAuthor, setSelectedAuthor] = useState(defaultAuthor);
  const [hfModels, setHfModels] = useState<HfModelSummary[]>([]);
  const [selectedRepo, setSelectedRepo] = useState(defaultRepoId);
  const [ggufGroups, setGgufGroups] = useState<GgufGroupOption[]>([]);
  const [selectedGroupKey, setSelectedGroupKey] = useState("");
  const [installProgress, setInstallProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);


  const formatError = useCallback(
    (err: unknown): string => formatBridgeFetchError(normalizedBridgeUrl, err),
    [normalizedBridgeUrl],
  );


  const sortedGgufGroups = useMemo(
    () => sortAlphaDescNumeric(ggufGroups, (group) => group.displayLabel),
    [ggufGroups],
  );


  const selectedGgufGroup = useMemo(
    () => sortedGgufGroups.find((group) => group.groupKey === selectedGroupKey) ?? null,
    [sortedGgufGroups, selectedGroupKey],
  );


  const refreshSettings = useCallback(async (): Promise<void> => {
    const settings = await fetchOfflineVisionSettings(normalizedBridgeUrl);
    setSelectedModelId(settings.selectedModelId ?? "");
    setInstalled(settings.installed);
    if (!settings.selectedModelId && settings.installed[0]) {
      setSelectedModelId(settings.installed[0].id);
    }
  }, [normalizedBridgeUrl]);


  useEffect(() => {
    setSelectedAuthor(defaultAuthor);
    setSelectedRepo(defaultRepoId);
    setSelectedGroupKey("");
  }, [defaultAuthor, defaultRepoId]);


  const loadGgufGroups = useCallback(async (repoId: string): Promise<void> => {
    if (!repoId) {
      setGgufGroups([]);
      setSelectedGroupKey("");
      return;
    }
    const result = await fetchLocalVlmHfFiles(normalizedBridgeUrl, repoId);
    const groups = sortAlphaDescNumeric(result.groups, (group) => group.displayLabel);
    setGgufGroups(groups);
    setSelectedGroupKey(groups[0]?.groupKey ?? "");
  }, [normalizedBridgeUrl]);


  const loadHfModels = useCallback(async (author: string): Promise<void> => {
    if (!author) {
      setHfModels([]);
      return;
    }
    const result = await fetchLocalVlmHfModels(normalizedBridgeUrl, author);
    setHfModels(result.models);
  }, [normalizedBridgeUrl]);


  useEffect(() => {
    void fetchLocalVlmAuthors(normalizedBridgeUrl)
      .then((result) => {
        const next = sortAlphaDescNumeric(result.authors, (item) => item);
        setAuthors(next);
        if (!next.includes(defaultAuthor)) {
          void addLocalVlmAuthor(normalizedBridgeUrl, defaultAuthor)
            .then((added) => setAuthors(sortAlphaDescNumeric(added.authors, (item) => item)))
            .catch(() => undefined);
        }
      })
      .catch((err: unknown) => setError(formatError(err)));
    void refreshSettings().catch((err: unknown) => setError(formatError(err)));
  }, [defaultAuthor, formatError, normalizedBridgeUrl, refreshSettings]);


  useEffect(() => {
    if (!selectedAuthor) {
      return;
    }
    void loadHfModels(selectedAuthor).catch((err: unknown) => setError(formatError(err)));
  }, [selectedAuthor, loadHfModels, formatError]);


  useEffect(() => {
    if (!selectedRepo) {
      return;
    }
    void loadGgufGroups(selectedRepo).catch((err: unknown) => setError(formatError(err)));
  }, [selectedRepo, loadGgufGroups, formatError]);


  const handleSelectInstalled = async (modelId: string): Promise<void> => {
    setSelectedModelId(modelId);
    setBusy(true);
    try {
      await patchOfflineVisionSettings(normalizedBridgeUrl, { selectedModelId: modelId || null });
      await refreshSettings();
    } catch (err: unknown) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };


  const handleInstall = async (): Promise<void> => {
    if (!selectedAuthor || !selectedRepo || !selectedGgufGroup) {
      return;
    }
    setBusy(true);
    setError(null);
    setInstallProgress("开始下载视觉模型（含 mmproj）…");
    try {
      const { jobId } = await installLocalVlmModel(normalizedBridgeUrl, {
        author: selectedAuthor,
        repoId: selectedRepo,
        ggufGroupKey: selectedGgufGroup.groupKey,
        filenames: selectedGgufGroup.filenames,
      });
      const deadline = Date.now() + 3_600_000;
      while (Date.now() < deadline) {
        const status = await fetchLocalVlmInstallStatus(normalizedBridgeUrl, jobId);
        setInstallProgress(status.progress);
        if (status.state === "done") {
          setInstallProgress("视觉模型安装完成");
          await refreshSettings();
          if (status.model?.id) {
            await handleSelectInstalled(status.model.id.replace(/^local-llm\//, "local-vlm/"));
          }
          break;
        }
        if (status.state === "error") {
          throw new Error(status.error ?? "安装失败");
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } catch (err: unknown) {
      setError(formatError(err));
      setInstallProgress(null);
    } finally {
      setBusy(false);
    }
  };


  const handleDelete = async (): Promise<void> => {
    if (!selectedModelId) {
      return;
    }
    setBusy(true);
    try {
      await deleteLocalVlmModel(normalizedBridgeUrl, selectedModelId);
      await refreshSettings();
      setSelectedModelId("");
    } catch (err: unknown) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };


  return (
    <section className="config-section local-vision-section">
      <h3>默认视觉模型</h3>
      <p className="config-hint">
        默认仓库 {defaultRepoId}（可在「配置」中修改）。安装时会自动附带同档位 mmproj；发图时由车道 3 编码后交接文本 LLM。
      </p>
      {error && <p className="config-error" role="alert">{error}</p>}
      {installProgress && <p className="config-save-toast" role="status">{installProgress}</p>}
      <label className="model-select local-models-select">
        <span className="model-select-label">当前使用的视觉模型</span>
        <select
          value={selectedModelId}
          onChange={(event) => void handleSelectInstalled(event.target.value)}
          disabled={busy || installed.length === 0}
        >
          <option value="">{installed.length === 0 ? "尚未安装" : "—"}</option>
          {installed.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}{item.weightsReady ? "" : " (不完整)"}
            </option>
          ))}
        </select>
      </label>
      <label className="model-select local-models-select">
        <span className="model-select-label">Hugging Face 作者</span>
        <select
          value={selectedAuthor}
          onChange={(event) => {
            setSelectedAuthor(event.target.value);
            setSelectedRepo("");
            setSelectedGroupKey("");
          }}
          disabled={busy}
        >
          {authors.map((author) => (
            <option key={author} value={author}>{author}</option>
          ))}
        </select>
      </label>
      <label className="model-select local-models-select">
        <span className="model-select-label">视觉仓库</span>
        <select
          value={selectedRepo}
          onChange={(event) => {
            setSelectedRepo(event.target.value);
            setSelectedGroupKey("");
          }}
          disabled={busy}
        >
          <option value="">—</option>
          {hfModels.map((model) => (
            <option key={model.repoId} value={model.repoId}>{model.displayName}</option>
          ))}
        </select>
      </label>
      <div className="local-models-row">
        <label className="model-select local-models-select local-models-grow">
          <span className="model-select-label">GGUF + mmproj 分组</span>
          <select
            value={selectedGroupKey}
            onChange={(event) => setSelectedGroupKey(event.target.value)}
            disabled={busy || !selectedRepo}
          >
            <option value="">—</option>
            {sortedGgufGroups.map((group) => (
              <option key={group.groupKey} value={group.groupKey}>
                {group.displayLabel} ({group.filenames.length} 文件)
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="local-models-add-btn"
          title="安装视觉模型"
          onClick={() => void handleInstall()}
          disabled={busy || !selectedRepo || !selectedGroupKey}
        >
          +
        </button>
        <button
          type="button"
          className="local-models-remove-btn"
          title="删除所选视觉模型"
          onClick={() => void handleDelete()}
          disabled={busy || !selectedModelId}
        >
          −
        </button>
      </div>
    </section>
  );
}
