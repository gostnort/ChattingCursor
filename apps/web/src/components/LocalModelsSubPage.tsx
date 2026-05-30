import { useCallback, useEffect, useMemo, useState } from "react";
import { sortAlphaDescNumeric } from "@chatting-cursor/shared";
import {
  addLocalLlmAuthor,
  deleteLocalLlmModel,
  fetchLocalLlmAuthors,
  fetchLocalLlmHfFiles,
  fetchLocalLlmHfModels,
  fetchLocalLlmInstalled,
  fetchLocalLlmInstallStatus,
  installLocalLlmModel,
  patchLocalLlmDefaultPrompt,
  type GgufGroupOption,
  type HfModelSummary,
  type InstalledLocalModel,
} from "../api/bridge";


interface LocalModelsSubPageProps {
  bridgeUrl: string;
}


/** 本地模型管理：HF 浏览、安装、删除、defaultPrompt */
export function LocalModelsSubPage({ bridgeUrl }: LocalModelsSubPageProps) {
  const [authors, setAuthors] = useState<string[]>([]);
  const [newAuthor, setNewAuthor] = useState("");
  const [selectedAuthor, setSelectedAuthor] = useState("");
  const [hfModels, setHfModels] = useState<HfModelSummary[]>([]);
  const [hfModelsLoading, setHfModelsLoading] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [ggufGroups, setGgufGroups] = useState<GgufGroupOption[]>([]);
  const [ggufGroupsLoading, setGgufGroupsLoading] = useState(false);
  const [selectedGroupKey, setSelectedGroupKey] = useState("");
  const [installed, setInstalled] = useState<InstalledLocalModel[]>([]);
  const [selectedInstalledId, setSelectedInstalledId] = useState("");
  const [defaultPrompt, setDefaultPrompt] = useState("");
  const [installProgress, setInstallProgress] = useState<string | null>(null);
  const [installPercent, setInstallPercent] = useState<number | null>(null);
  const [installIndeterminate, setInstallIndeterminate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteToast, setDeleteToast] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; label: string } | null>(null);


  const sortedAuthors = useMemo(
    () => sortAlphaDescNumeric(authors, (author) => author),
    [authors],
  );


  const sortedGgufGroups = useMemo(
    () => sortAlphaDescNumeric(ggufGroups, (group) => group.displayLabel),
    [ggufGroups],
  );


  const selectedGgufGroup = useMemo(
    () => sortedGgufGroups.find((group) => group.groupKey === selectedGroupKey) ?? null,
    [sortedGgufGroups, selectedGroupKey],
  );


  const installedRepoIdsForAuthor = useMemo(() => {
    return new Set(
      installed
        .filter((item) => item.author === selectedAuthor)
        .map((item) => item.repoId),
    );
  }, [installed, selectedAuthor]);


  const availableRepos = useMemo(() => {
    const filtered = hfModels.filter((model) => !installedRepoIdsForAuthor.has(model.repoId));
    return sortAlphaDescNumeric(filtered, (model) => model.displayName);
  }, [hfModels, installedRepoIdsForAuthor]);


  const sortedInstalled = useMemo(
    () => sortAlphaDescNumeric(installed, (model) => model.label),
    [installed],
  );


  const refreshInstalled = useCallback(async (preferredId?: string) => {
    const result = await fetchLocalLlmInstalled(bridgeUrl);
    setInstalled(result.models);
    if (result.models.length === 0) {
      setSelectedInstalledId("");
      setDefaultPrompt("");
      return;
    }
    if (preferredId === "") {
      setSelectedInstalledId("");
      setDefaultPrompt("");
      return;
    }
    const lookupId = preferredId ?? selectedInstalledId;
    const current = result.models.find((item) => item.id === lookupId) ?? result.models[0];
    if (current) {
      setSelectedInstalledId(current.id);
      setDefaultPrompt(current.defaultPrompt);
      return;
    }
    setSelectedInstalledId("");
    setDefaultPrompt("");
  }, [bridgeUrl, selectedInstalledId]);


  const loadGgufGroups = useCallback(async (repoId: string): Promise<void> => {
    if (!repoId) {
      setGgufGroups([]);
      setSelectedGroupKey("");
      return;
    }
    setGgufGroupsLoading(true);
    setError(null);
    try {
      const result = await fetchLocalLlmHfFiles(bridgeUrl, repoId);
      const groups = sortAlphaDescNumeric(result.groups, (group) => group.displayLabel);
      setGgufGroups(groups);
      setSelectedGroupKey(groups[0]?.groupKey ?? "");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setGgufGroups([]);
      setSelectedGroupKey("");
    } finally {
      setGgufGroupsLoading(false);
    }
  }, [bridgeUrl]);


  const loadHfModels = useCallback(async (author: string): Promise<void> => {
    if (!author) {
      setHfModels([]);
      return;
    }
    setHfModelsLoading(true);
    setError(null);
    try {
      const result = await fetchLocalLlmHfModels(bridgeUrl, author);
      setHfModels(result.models);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setHfModels([]);
    } finally {
      setHfModelsLoading(false);
    }
  }, [bridgeUrl]);


  useEffect(() => {
    void fetchLocalLlmAuthors(bridgeUrl)
      .then((result) => {
        const nextAuthors = sortAlphaDescNumeric(result.authors, (author) => author);
        setAuthors(nextAuthors);
        if (nextAuthors.length > 0 && !selectedAuthor) {
          setSelectedAuthor(nextAuthors[0] ?? "");
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    void refreshInstalled().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [bridgeUrl, refreshInstalled, selectedAuthor]);


  useEffect(() => {
    if (!selectedAuthor) {
      setHfModels([]);
      setSelectedRepo("");
      setGgufGroups([]);
      setSelectedGroupKey("");
      return;
    }
    void loadHfModels(selectedAuthor);
  }, [selectedAuthor, loadHfModels]);


  useEffect(() => {
    if (!selectedRepo) {
      setGgufGroups([]);
      setSelectedGroupKey("");
      return;
    }
    void loadGgufGroups(selectedRepo);
  }, [selectedRepo, loadGgufGroups]);


  useEffect(() => {
    if (selectedRepo && installedRepoIdsForAuthor.has(selectedRepo)) {
      setSelectedRepo("");
    }
  }, [installedRepoIdsForAuthor, selectedRepo]);


  useEffect(() => {
    if (!deleteToast) {
      return;
    }
    const timer = setTimeout(() => setDeleteToast(null), 4000);
    return () => clearTimeout(timer);
  }, [deleteToast]);


  const handleAddAuthor = async (): Promise<void> => {
    const name = newAuthor.trim();
    if (!name) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await addLocalLlmAuthor(bridgeUrl, name);
      setAuthors(sortAlphaDescNumeric(result.authors, (author) => author));
      setSelectedAuthor(name);
      setNewAuthor("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };


  const handleInstall = async (): Promise<void> => {
    if (!selectedAuthor || !selectedRepo || !selectedGgufGroup) {
      return;
    }
    const repo = availableRepos.find((item) => item.repoId === selectedRepo);
    setBusy(true);
    setError(null);
    setInstallProgress("开始下载…");
    setInstallPercent(null);
    setInstallIndeterminate(true);
    try {
      const { jobId } = await installLocalLlmModel(bridgeUrl, {
        author: selectedAuthor,
        repoId: selectedRepo,
        ggufGroupKey: selectedGgufGroup.groupKey,
        filenames: selectedGgufGroup.filenames,
        displayName: repo?.displayName,
      });
      if (!jobId?.trim()) {
        throw new Error("安装未返回 jobId");
      }
      const deadline = Date.now() + 3_600_000;
      let notFoundRetries = 0;
      while (Date.now() < deadline) {
        let status;
        try {
          status = await fetchLocalLlmInstallStatus(bridgeUrl, jobId);
          notFoundRetries = 0;
        } catch (pollError: unknown) {
          const message = pollError instanceof Error ? pollError.message : String(pollError);
          if (message.includes("安装任务不存在") && notFoundRetries < 5) {
            notFoundRetries += 1;
            setInstallProgress(`等待安装任务… (${notFoundRetries}/5)`);
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          throw pollError;
        }
        setInstallProgress(status.progress);
        const hasTotal = typeof status.totalBytes === "number" && status.totalBytes > 0;
        const pct = typeof status.percent === "number" ? status.percent : null;
        setInstallIndeterminate(!hasTotal && status.state === "running");
        setInstallPercent(hasTotal && pct !== null ? Math.min(100, Math.max(0, pct)) : null);
        if (status.state === "done") {
          setInstallProgress(status.progress || "安装完成");
          setInstallPercent(100);
          setInstallIndeterminate(false);
          await refreshInstalled();
          await loadHfModels(selectedAuthor);
          setSelectedRepo("");
          setSelectedGroupKey("");
          setGgufGroups([]);
          break;
        }
        if (status.state === "error") {
          await refreshInstalled();
          throw new Error(status.error ?? status.progress ?? "安装失败");
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setInstallProgress(null);
      setInstallPercent(null);
      setInstallIndeterminate(false);
      await refreshInstalled().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };


  const openDeleteConfirm = (): void => {
    const deletingId = selectedInstalledId;
    if (!deletingId || deleting) {
      return;
    }
    const modelLabel = installed.find((item) => item.id === deletingId)?.label ?? deletingId;
    setDeleteConfirm({ id: deletingId, label: modelLabel });
  };


  const closeDeleteConfirm = (): void => {
    if (deleting) {
      return;
    }
    setDeleteConfirm(null);
  };


  const confirmDeleteInstalled = async (): Promise<void> => {
    const deletingId = deleteConfirm?.id;
    if (!deletingId) {
      return;
    }
    setDeleting(true);
    setError(null);
    setDeleteToast(null);
    try {
      await deleteLocalLlmModel(bridgeUrl, deletingId);
      setDeleteConfirm(null);
      setSelectedInstalledId("");
      setDefaultPrompt("");
      await refreshInstalled("");
      if (selectedAuthor) {
        await loadHfModels(selectedAuthor);
      }
      setDeleteToast("已删除");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };


  const handleSavePrompt = async (): Promise<void> => {
    if (!selectedInstalledId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await patchLocalLlmDefaultPrompt(bridgeUrl, selectedInstalledId, defaultPrompt);
      await refreshInstalled();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };


  return (
    <div className="local-sub-panel local-models-page">
      <h2>本地模型</h2>
      <p className="config-hint">从 Hugging Face 浏览并安装 GGUF；先选仓库，再选量化/分片，点击 + 仅下载所选分组。</p>
      {error && <p className="config-error" role="alert">{error}</p>}
      {deleteToast && <p className="config-save-toast" role="status">{deleteToast}</p>}
      {installProgress && (
        <div className="local-install-progress" role="status" aria-live="polite">
          <progress
            className="local-install-progress-bar"
            max={100}
            value={installIndeterminate ? undefined : (installPercent ?? 0)}
          />
          <p className="config-save-toast local-install-progress-text">{installProgress}</p>
        </div>
      )}

      <section className="config-section">
        <h3>1. Hugging Face 作者</h3>
        <div className="local-models-row">
          <input
            type="text"
            className="local-models-control"
            value={newAuthor}
            onChange={(event) => setNewAuthor(event.target.value)}
            placeholder="例如 unsloth"
            disabled={busy}
          />
          <button type="button" className="btn-secondary local-models-btn" onClick={() => void handleAddAuthor()} disabled={busy}>
            添加
          </button>
        </div>
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
            <option value="">—</option>
            {sortedAuthors.map((author) => (
              <option key={author} value={author}>{author}</option>
            ))}
          </select>
        </label>
      </section>

      <section className="config-section">
        <h3>2. Hugging Face 仓库</h3>
        <label className="model-select local-models-select">
          <select
            value={selectedRepo}
            onChange={(event) => {
              setSelectedRepo(event.target.value);
              setSelectedGroupKey("");
            }}
            disabled={busy || !selectedAuthor || hfModelsLoading}
            aria-label="Hugging Face 仓库"
          >
            <option value="">{hfModelsLoading ? "加载中…" : "—"}</option>
            {availableRepos.map((model) => (
              <option key={model.repoId} value={model.repoId}>{model.displayName}</option>
            ))}
          </select>
        </label>
      </section>

      <section className="config-section">
        <h3>3. GGUF 量化 / 分片</h3>
        <div className="local-models-row">
          <label className="model-select local-models-select local-models-grow">
            <select
              value={selectedGroupKey}
              onChange={(event) => setSelectedGroupKey(event.target.value)}
              disabled={busy || !selectedRepo || ggufGroupsLoading}
              aria-label="GGUF 量化或分片"
            >
              <option value="">
                {!selectedRepo ? "请先选择仓库" : ggufGroupsLoading ? "加载中…" : sortedGgufGroups.length === 0 ? "无可用 GGUF" : "—"}
              </option>
              {sortedGgufGroups.map((group) => (
                <option key={group.groupKey} value={group.groupKey}>
                  {group.displayLabel}{group.filenames.length > 1 ? ` (${group.filenames.length} 分片)` : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="local-models-add-btn"
            title="安装所选 GGUF 分组"
            onClick={() => void handleInstall()}
            disabled={busy || !selectedRepo || !selectedGroupKey || ggufGroupsLoading}
          >
            +
          </button>
        </div>
      </section>

      <section className="config-section">
        <h3>4. 已安装</h3>
        <div className="local-models-row">
          <label className="model-select local-models-select local-models-grow">
            <span className="model-select-label">已安装模型</span>
            <select
              value={selectedInstalledId}
              onChange={(event) => {
                const id = event.target.value;
                setSelectedInstalledId(id);
                const model = installed.find((item) => item.id === id);
                setDefaultPrompt(model?.defaultPrompt ?? "");
              }}
              disabled={busy}
            >
              <option value="">—</option>
              {sortedInstalled.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}{model.weightsReady ? "" : " (权重不完整)"}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="local-models-remove-btn"
            title="删除此模型"
            onClick={openDeleteConfirm}
            disabled={deleting || !selectedInstalledId}
            aria-busy={deleting}
          >
            {deleting ? "…" : "−"}
          </button>
        </div>
        <label className="config-field">
          <span>选定模型的初始化提示词</span>
          <textarea
            rows={4}
            value={defaultPrompt}
            onChange={(event) => setDefaultPrompt(event.target.value)}
            disabled={busy || !selectedInstalledId}
          />
        </label>
        <button
          type="button"
          className="btn-secondary local-models-btn"
          onClick={() => void handleSavePrompt()}
          disabled={busy || !selectedInstalledId}
        >
          保存提示词
        </button>
      </section>

      {deleteConfirm && (
        <div
          className="local-models-delete-overlay"
          role="presentation"
          onClick={closeDeleteConfirm}
        >
          <div
            className="local-models-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="local-models-delete-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h4 id="local-models-delete-title">确认删除</h4>
            <p>
              确定删除「{deleteConfirm.label}」及全部权重文件？
              若模型正在运行或下载，将先卸载并取消安装。
            </p>
            <div className="local-models-delete-actions">
              <button
                type="button"
                className="btn-secondary local-models-btn"
                onClick={closeDeleteConfirm}
                disabled={deleting}
              >
                否
              </button>
              <button
                type="button"
                className="local-models-remove-btn local-models-delete-yes"
                onClick={() => void confirmDeleteInstalled()}
                disabled={deleting}
                aria-busy={deleting}
              >
                {deleting ? "…" : "是"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
