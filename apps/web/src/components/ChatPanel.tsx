import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type TouchEvent,
} from "react";
import type { ChatMessage, ModelInfo } from "@chatting-cursor/shared";
import {
  buildModelDisplayAuthorListFromModelIds,
  formatLocalLlmError,
  formatModelDisplayLabel,
  formatOfflineLoadStatus,
  isOfflineModelId,
} from "@chatting-cursor/shared";
import {
  analyzeChatImage,
  createChatSession,
  fetchRecentChatSession,
  fetchModels,
  mergeAssistantStreamText,
  cancelChatRun,
  fetchRunFinalText,
  sendChatMessage,
  subscribeRunEvents,
  uploadChatImage,
  fetchOfflineModelStatus,
  stopLocalLlmSidecar,
  warmupOfflineModel,
} from "../api/bridge";
import {
  clearChatState,
  clearOfflineModelContext,
  loadOfflineModelContext,
  loadOnlineChatSnapshot,
  MODEL_STORAGE_KEY,
  resolveInitialChatState,
  saveChatState,
  saveOfflineModelContext,
} from "../chatPersistence";
import { OFFLINE_RESET_NOTICE, resolveModelOnReconnect } from "../modelReconnect";
import { isLocalBridgeUrl, isLocalWebWithRemoteBridge } from "../bridgeSettings";
import { isLocalWebOrigin } from "../environment";
import { useSpeech } from "../hooks/useSpeech";
import { playNotificationSound } from "../utils/notificationSound";
import {
  clampSelectionToBubble,
  isEditableFocusedTarget,
  selectElementText,
} from "../utils/selectBubbleText";
import { MessageBubble } from "./MessageBubble";


const LATEST_RUN_ID_KEY = "latestRunId";
const OFFLINE_LOAD_TIMEOUT_MS = 600_000;
const SSE_IDLE_TIMEOUT_MS = 5_000;
// 离线模型通知约定：顶栏 offlineLoadPhase 仅展示预热/加载进度（waiting/loading/ready）与预热失败；
// 聊天 SSE 推理/SSE 连接失败时，完整错误只写入助手气泡，避免顶栏与气泡重复同一段文案。


interface ChatPanelProps {
  bridgeUrl: string;
  bridgeToken: string;
}


function shortenModelLabel(
  label: string,
  modelId?: string,
  allAuthors?: readonly string[],
): string {
  const trimmed = label.trim();
  if (!trimmed) {
    return "Agent";
  }
  if (modelId && isOfflineModelId(modelId)) {
    return formatModelDisplayLabel(modelId, allAuthors);
  }
  if (trimmed.includes("/") && !trimmed.includes(" ")) {
    return formatModelDisplayLabel(trimmed, allAuthors);
  }
  const compact = trimmed.replace(/\s*\(.*?\)\s*/g, "").trim();
  if (/^kimi/i.test(compact)) {
    return compact.includes("K2.5") ? "Kimi K2.5" : "Kimi";
  }
  if (/^gpt/i.test(compact)) {
    return compact.split(/\s+/).slice(0, 2).join(" ");
  }
  if (/^codex/i.test(compact)) {
    return compact.split(/\s+/).slice(0, 2).join(" ");
  }
  if (/^composer/i.test(compact)) {
    return compact.split(/\s+/).slice(0, 2).join(" ");
  }
  if (/^opus/i.test(compact) || /^sonnet/i.test(compact) || /^gemini/i.test(compact)) {
    return compact.split(/\s+/).slice(0, 2).join(" ");
  }
  return compact.length > 12 ? compact.slice(0, 12) : compact;
}


function normalizeModelBase(label: string): string {
  return label.replace(/\s*\(.*?\)\s*/g, "").trim();
}


function extractModelGroupKey(label: string): string {
  const base = normalizeModelBase(label);
  if (/^auto$/i.test(base)) {
    return "auto";
  }
  const parts = base.match(/[A-Za-z]+(?:\d+(?:\.\d+)?)?|\d+(?:\.\d+)?[A-Za-z]*/g) ?? [];
  if (parts.length >= 2) {
    return parts.slice(0, 2).join("|").toLowerCase();
  }
  if (parts.length > 0) {
    return parts.join("|").toLowerCase();
  }
  return base.toLowerCase();
}


function compressModelOptions(source: ModelInfo[]): {
  models: ModelInfo[];
  aliases: Map<string, string>;
} {
  const offline = source.filter((model) => model.kind === "offline");
  const separators = source.filter((model) => model.kind === "separator");
  const online = source.filter((model) => model.kind !== "offline" && model.kind !== "separator");
  const groups = new Map<string, ModelInfo[]>();
  const compressedOnline: ModelInfo[] = [];
  const aliases = new Map<string, string>();
  for (const model of offline) {
    aliases.set(model.id, model.id);
  }
  for (const model of online) {
    const key = extractModelGroupKey(model.label);
    const group = groups.get(key) ?? [];
    group.push(model);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const representative = [...group].sort((left, right) => {
      const leftBase = normalizeModelBase(left.label);
      const rightBase = normalizeModelBase(right.label);
      return leftBase.length - rightBase.length || left.label.length - right.label.length;
    })[0];
    if (!representative) {
      continue;
    }
    const hasDefault = group.some((item) => item.isDefault);
    compressedOnline.push({
      ...representative,
      isDefault: hasDefault || representative.isDefault,
    });
    for (const item of group) {
      aliases.set(item.id, representative.id);
    }
  }
  compressedOnline.sort((left, right) => {
    if (left.isDefault && !right.isDefault) {
      return -1;
    }
    if (!left.isDefault && right.isDefault) {
      return 1;
    }
    return normalizeModelBase(left.label).localeCompare(normalizeModelBase(right.label));
  });
  offline.sort((left, right) => left.label.localeCompare(right.label));
  const models = [...offline, ...separators, ...compressedOnline];
  return { models, aliases };
}


/** 最小聊天面板 */
export function ChatPanel({ bridgeUrl, bridgeToken }: ChatPanelProps) {
  const initialChatState = resolveInitialChatState();
  const [messages, setMessages] = useState<ChatMessage[]>(() => initialChatState.messages);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [modelSwitchNotice, setModelSwitchNotice] = useState<string | null>(null);
  const [offlineLoadPhase, setOfflineLoadPhase] = useState<"idle" | "waiting" | "loading" | "ready" | "error">("idle");
  const [offlineLoadMessage, setOfflineLoadMessage] = useState<string | null>(null);
  const offlineWarmupGenerationRef = useRef(0);
  const bridgeConnectionRef = useRef<{ url: string; token: string } | null>(null);
  const chatSnapshotRef = useRef({ messages: initialChatState.messages, sessionId: initialChatState.sessionId });
  const [selectedModel, setSelectedModel] = useState(() => initialChatState.selectedModel);
  const [sessionId, setSessionId] = useState<string | null>(() => initialChatState.sessionId);
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const [isImageAnalyzing, setIsImageAnalyzing] = useState(false);
  const assistantBufferRef = useRef("");
  const stderrBufferRef = useRef("");
  const currentAssistantLabelRef = useRef("Agent");
  const sseCloseRef = useRef<(() => void) | null>(null);
  const currentRunIdRef = useRef<string | null>(null);
  const runFinishedRef = useRef(false);
  const sendQueueRef = useRef<string[]>([]);
  const runInFlightRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { toggleSpeak, speakingKey } = useSpeech();
  const compressedModels = useMemo(() => compressModelOptions(models), [models]);
  const offlineDisplayAuthors = useMemo(
    () => buildModelDisplayAuthorListFromModelIds(models.map((item) => item.id)),
    [models],
  );


  useEffect(() => {
    chatSnapshotRef.current = { messages, sessionId };
  }, [messages, sessionId]);


  const applyChatSnapshot = useCallback((snapshot: { messages: ChatMessage[]; sessionId: string | null }): void => {
    sseCloseRef.current?.();
    sseCloseRef.current = null;
    currentRunIdRef.current = null;
    runFinishedRef.current = false;
    sendQueueRef.current = [];
    runInFlightRef.current = false;
    assistantBufferRef.current = "";
    stderrBufferRef.current = "";
    setMessages(snapshot.messages);
    setSessionId(snapshot.sessionId);
    setIsSending(false);
    setIsThinking(false);
    setFocusedMessageId(null);
  }, []);


  const restoreOnlineChatFromStorage = useCallback((): void => {
    const onlineSnapshot = loadOnlineChatSnapshot();
    if (onlineSnapshot) {
      applyChatSnapshot(onlineSnapshot);
      return;
    }
    applyChatSnapshot({ messages: [], sessionId: null });
  }, [applyChatSnapshot]);


  const persistOfflineModelContext = useCallback((modelId: string): void => {
    if (!isOfflineModelId(modelId)) {
      return;
    }
    const snapshot = chatSnapshotRef.current;
    if (snapshot.messages.length === 0 && !snapshot.sessionId) {
      return;
    }
    saveOfflineModelContext(modelId, snapshot);
  }, []);


  const resetOfflineLoadState = useCallback((): void => {
    offlineWarmupGenerationRef.current += 1;
    setOfflineLoadPhase("idle");
    setOfflineLoadMessage(null);
  }, []);


  const unloadOfflineSidecar = useCallback(async (): Promise<void> => {
    resetOfflineLoadState();
    if (!bridgeUrl) {
      return;
    }
    try {
      await stopLocalLlmSidecar(bridgeUrl);
    } catch {
      // sidecar 可能已停止，忽略
    }
  }, [bridgeUrl, resetOfflineLoadState]);


  const startFreshChatSession = useCallback(async (): Promise<void> => {
    applyChatSnapshot({ messages: [], sessionId: null });
    try {
      const result = await createChatSession(bridgeUrl, bridgeToken);
      setSessionId(result.sessionId);
      setConnectionError(null);
    } catch {
      setSessionId(null);
    }
  }, [applyChatSnapshot, bridgeToken, bridgeUrl]);


  const resizeComposer = useCallback((): void => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    const maxHeight = Math.min(window.innerHeight * 0.45, 352);
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${Math.max(nextHeight, 112)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);


  useEffect(() => {
    let cancelled = false;
    const loadModels = async (): Promise<void> => {
      if (!bridgeUrl) {
        setModels([]);
        setConnectionError("请先到“本地 → 配置”填写可访问的 Bridge URL。手机使用 GitHub Pages 时，这里必须是你电脑的公网 Bridge 地址。");
        return;
      }
      try {
        const result = await fetchModels(bridgeUrl, bridgeToken);
        if (cancelled) {
          return;
        }
        setConnectionError(null);
        setModels(result.models);
        const stored = localStorage.getItem(MODEL_STORAGE_KEY) ?? "";
        const aliasMap = compressModelOptions(result.models).aliases;
        const { modelId, resetFromOffline } = resolveModelOnReconnect(stored, result.models, aliasMap);
        if (resetFromOffline) {
          if (isOfflineModelId(stored)) {
            persistOfflineModelContext(stored);
          }
          restoreOnlineChatFromStorage();
          void unloadOfflineSidecar();
          setModelSwitchNotice(OFFLINE_RESET_NOTICE);
        }
        setSelectedModel(modelId);
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setConnectionError(message);
        }
      }
    };
    void loadModels();
    return () => {
      cancelled = true;
    };
  }, [bridgeToken, bridgeUrl, persistOfflineModelContext, restoreOnlineChatFromStorage, unloadOfflineSidecar]);


  useEffect(() => {
    let cancelled = false;
    const initSession = async (): Promise<void> => {
      if (!bridgeUrl) {
        setSessionId(null);
        return;
      }
      if (sessionId) {
        return;
      }
      try {
        const recent = await fetchRecentChatSession(bridgeUrl, bridgeToken);
        if (!cancelled && recent) {
          if (recent.model && isOfflineModelId(recent.model)) {
            saveOfflineModelContext(recent.model, {
              messages: recent.messages,
              sessionId: recent.sessionId,
            });
            restoreOnlineChatFromStorage();
            if (models.length > 0) {
              const { modelId, resetFromOffline } = resolveModelOnReconnect(
                recent.model,
                models,
                compressedModels.aliases,
              );
              setSelectedModel(modelId);
              if (resetFromOffline) {
                void unloadOfflineSidecar();
                setModelSwitchNotice(OFFLINE_RESET_NOTICE);
              }
            }
            setConnectionError(null);
            return;
          }
          setSessionId(recent.sessionId);
          setMessages(recent.messages);
          if (recent.model && models.length > 0) {
            const { modelId, resetFromOffline } = resolveModelOnReconnect(
              recent.model,
              models,
              compressedModels.aliases,
            );
            setSelectedModel(modelId);
            if (resetFromOffline) {
              void unloadOfflineSidecar();
              setModelSwitchNotice(OFFLINE_RESET_NOTICE);
            }
          }
          setConnectionError(null);
          return;
        }
        const result = await createChatSession(bridgeUrl, bridgeToken);
        if (!cancelled) {
          setSessionId(result.sessionId);
          setConnectionError(null);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setConnectionError(message);
        }
      }
    };
    void initSession();
    return () => {
      cancelled = true;
      // initSession 依赖变化时不误杀活跃 SSE
      if (!currentRunIdRef.current) {
        sseCloseRef.current?.();
      }
    };
  }, [bridgeToken, bridgeUrl, compressedModels.aliases, models, persistOfflineModelContext, restoreOnlineChatFromStorage, sessionId, unloadOfflineSidecar]);


  useEffect(() => {
    const prev = bridgeConnectionRef.current;
    bridgeConnectionRef.current = { url: bridgeUrl, token: bridgeToken };
    if (!prev || (prev.url === bridgeUrl && prev.token === bridgeToken) || models.length === 0) {
      return;
    }
    if (!isOfflineModelId(selectedModel)) {
      return;
    }
    persistOfflineModelContext(selectedModel);
    restoreOnlineChatFromStorage();
    void unloadOfflineSidecar();
    const { modelId, resetFromOffline } = resolveModelOnReconnect(
      selectedModel,
      models,
      compressedModels.aliases,
    );
    setSelectedModel(modelId);
    if (resetFromOffline) {
      setModelSwitchNotice(OFFLINE_RESET_NOTICE);
    }
  }, [bridgeToken, bridgeUrl, compressedModels.aliases, models, persistOfflineModelContext, restoreOnlineChatFromStorage, selectedModel, unloadOfflineSidecar]);


  useEffect(() => {
    if (!modelSwitchNotice) {
      return;
    }
    const timer = window.setTimeout(() => setModelSwitchNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [modelSwitchNotice]);


  useEffect(() => {
    if (isOfflineModelId(selectedModel)) {
      saveOfflineModelContext(selectedModel, { messages, sessionId });
    } else if (selectedModel) {
      saveChatState({ messages, sessionId, selectedModel });
    }
    if (selectedModel) {
      localStorage.setItem(MODEL_STORAGE_KEY, selectedModel);
    }
  }, [messages, sessionId, selectedModel]);


  useEffect(() => {
    if (!isOfflineModelId(selectedModel)) {
      setOfflineLoadPhase("idle");
      setOfflineLoadMessage(null);
      return;
    }
    if (!bridgeUrl) {
      return;
    }
    const generation = offlineWarmupGenerationRef.current + 1;
    offlineWarmupGenerationRef.current = generation;
    setOfflineLoadPhase("waiting");
    setOfflineLoadMessage("1 秒后将开始加载本地模型…");
    let pollTimer: number | undefined;
    let loadTimeoutTimer: number | undefined;
    let pollFailures = 0;
    const delayTimer = window.setTimeout(() => {
      if (offlineWarmupGenerationRef.current !== generation) {
        return;
      }
      setOfflineLoadPhase("loading");
      setOfflineLoadMessage("正在加载本地模型，请稍候…");
      loadTimeoutTimer = window.setTimeout(() => {
        if (offlineWarmupGenerationRef.current !== generation) {
          return;
        }
        setOfflineLoadPhase("error");
        setOfflineLoadMessage(formatLocalLlmError("模型加载超时（超过 600 秒）"));
      }, OFFLINE_LOAD_TIMEOUT_MS);
      pollTimer = window.setInterval(() => {
        if (offlineWarmupGenerationRef.current !== generation) {
          return;
        }
        void fetchOfflineModelStatus(bridgeUrl, selectedModel, bridgeToken)
          .then((status) => {
            if (offlineWarmupGenerationRef.current !== generation) {
              return;
            }
            if (status.ready) {
              setOfflineLoadPhase("ready");
              setOfflineLoadMessage("加载完成");
              return;
            }
            if (status.error || status.loadState === "error") {
              setOfflineLoadPhase("error");
              setOfflineLoadMessage(formatLocalLlmError(status.error ?? status.message ?? "本地模型加载失败"));
              return;
            }
            if (status.weights === "missing" || status.weights === "incomplete") {
              setOfflineLoadPhase("error");
              setOfflineLoadMessage(formatLocalLlmError("本地模型权重不完整或未安装"));
              return;
            }
            pollFailures = 0;
            if (status.message) {
              setOfflineLoadMessage(status.message);
            }
          })
          .catch(() => {
            pollFailures += 1;
            if (pollFailures >= 4 && offlineWarmupGenerationRef.current === generation) {
              setOfflineLoadPhase("error");
              setOfflineLoadMessage(formatLocalLlmError("无法连接 Bridge 查询本地模型状态，请确认 Bridge 已启动"));
            }
          });
      }, 2500);
      void warmupOfflineModel(bridgeUrl, selectedModel, bridgeToken)
        .then((result) => {
          if (offlineWarmupGenerationRef.current !== generation) {
            return;
          }
          if (result.ready) {
            setOfflineLoadPhase("ready");
            setOfflineLoadMessage(
              result.loadState === "ready"
                ? "加载完成"
                : (result.message ?? "推理服务已就绪；发送消息时将加载模型"),
            );
            return;
          }
          if (result.loadState === "loading") {
            setOfflineLoadPhase("loading");
            if (result.message) {
              setOfflineLoadMessage(result.message);
            }
            return;
          }
          setOfflineLoadPhase("error");
          setOfflineLoadMessage(formatLocalLlmError(result.error ?? result.message ?? "本地模型未就绪"));
        })
        .catch((error: unknown) => {
          if (offlineWarmupGenerationRef.current !== generation) {
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          setOfflineLoadPhase("error");
          setOfflineLoadMessage(formatLocalLlmError(message));
        })
        .finally(() => {
          if (pollTimer !== undefined) {
            window.clearInterval(pollTimer);
          }
          if (loadTimeoutTimer !== undefined) {
            window.clearTimeout(loadTimeoutTimer);
          }
        });
    }, 1000);
    return () => {
      window.clearTimeout(delayTimer);
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
      }
      if (loadTimeoutTimer !== undefined) {
        window.clearTimeout(loadTimeoutTimer);
      }
    };
  }, [bridgeToken, bridgeUrl, selectedModel]);


  useEffect(() => {
    if (!selectedModel) {
      return;
    }
    const mapped = compressedModels.aliases.get(selectedModel);
    if (mapped && mapped !== selectedModel) {
      setSelectedModel(mapped);
      localStorage.setItem(MODEL_STORAGE_KEY, mapped);
    }
  }, [compressedModels.aliases, selectedModel]);


  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isSending, isThinking]);


  useEffect(() => {
    resizeComposer();
    window.addEventListener("resize", resizeComposer);
    return () => window.removeEventListener("resize", resizeComposer);
  }, [input, resizeComposer]);


  useEffect(() => {
    const handleSelectAll = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a") {
        return;
      }
      if (isEditableFocusedTarget(event.target)) {
        return;
      }
      if (!focusedMessageId) {
        return;
      }
      const bubbleText = document.querySelector<HTMLElement>(
        `[data-message-id="${focusedMessageId}"] .bubble-text`,
      );
      if (!bubbleText) {
        return;
      }
      event.preventDefault();
      selectElementText(bubbleText);
    };
    document.addEventListener("keydown", handleSelectAll, true);
    return () => document.removeEventListener("keydown", handleSelectAll, true);
  }, [focusedMessageId]);


  useEffect(() => {
    const handleSelectionChange = (): void => {
      if (!focusedMessageId) {
        return;
      }
      clampSelectionToBubble(focusedMessageId);
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [focusedMessageId]);


  const messagesRef = useRef<HTMLDivElement | null>(null);


  useEffect(() => {
    const messagesEl = messagesRef.current;
    if (!messagesEl) {
      return;
    }
    const handleSelectStart = (event: Event): void => {
      if (isEditableFocusedTarget(event.target)) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Node)) {
        event.preventDefault();
        return;
      }
      const element = target instanceof HTMLElement ? target : target.parentElement;
      if (element?.closest(".bubble-text")) {
        return;
      }
      event.preventDefault();
    };
    messagesEl.addEventListener("selectstart", handleSelectStart);
    return () => messagesEl.removeEventListener("selectstart", handleSelectStart);
  }, []);


  const focusMessageFromEventTarget = (target: EventTarget | null): void => {
    if (!(target instanceof HTMLElement)) {
      setFocusedMessageId(null);
      return;
    }
    const row = target.closest<HTMLElement>("[data-message-id]");
    if (row?.dataset.messageId) {
      setFocusedMessageId(row.dataset.messageId);
      return;
    }
    setFocusedMessageId(null);
  };


  const handleMessagesPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    focusMessageFromEventTarget(event.target);
  };


  const handleMessagesTouchStart = (event: TouchEvent<HTMLDivElement>): void => {
    focusMessageFromEventTarget(event.target);
  };


  const handleModelChange = (value: string): void => {
    const previous = selectedModel;
    if (isOfflineModelId(previous)) {
      persistOfflineModelContext(previous);
    }
    if (isOfflineModelId(previous) && !isOfflineModelId(value)) {
      void unloadOfflineSidecar();
    }
    setSelectedModel(value);
    localStorage.setItem(MODEL_STORAGE_KEY, value);
    if (isOfflineModelId(value)) {
      const snapshot = loadOfflineModelContext(value);
      if (snapshot) {
        applyChatSnapshot(snapshot);
        setModelSwitchNotice("已恢复该离线模型的上次对话。");
        return;
      }
      void startFreshChatSession();
      return;
    }
    const onlineSnapshot = loadOnlineChatSnapshot();
    if (onlineSnapshot) {
      applyChatSnapshot(onlineSnapshot);
      return;
    }
    void startFreshChatSession();
  };


  const resetChatState = (): void => {
    sseCloseRef.current?.();
    sseCloseRef.current = null;
    currentRunIdRef.current = null;
    runFinishedRef.current = false;
    sendQueueRef.current = [];
    runInFlightRef.current = false;
    assistantBufferRef.current = "";
    stderrBufferRef.current = "";
    setMessages([]);
    setIsSending(false);
    setIsThinking(false);
    setFocusedMessageId(null);
  };


  const drainSendQueue = (): void => {
    const next = sendQueueRef.current.shift();
    if (next) {
      void startRun(next);
      return;
    }
    runInFlightRef.current = false;
    setIsSending(false);
    setIsThinking(false);
  };


  const appendAssistantError = (content: string): void => {
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content,
        createdAt: new Date().toISOString(),
        modelLabel: currentAssistantLabelRef.current,
      },
    ]);
  };


  const updateLastAssistantBubble = (content: string): void => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant") {
        return [...prev.slice(0, -1), {
          ...last,
          content,
          modelLabel: last.modelLabel ?? currentAssistantLabelRef.current,
        }];
      }
      if (!content) {
        return prev;
      }
      return [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          modelLabel: currentAssistantLabelRef.current,
        },
      ];
    });
  };


  const alignAssistantWithBridgeFinalText = async (runId: string): Promise<void> => {
    try {
      const { text } = await fetchRunFinalText(bridgeUrl, runId, bridgeToken);
      if (!text) {
        return;
      }
      assistantBufferRef.current = mergeAssistantStreamText(assistantBufferRef.current, text);
      updateLastAssistantBubble(assistantBufferRef.current);
    } catch {
      // 对齐失败不影响主流程，保留 SSE 已收到的文本
    }
  };


  const revertOfflineTopAfterChatFailure = (): void => {
    setOfflineLoadPhase("ready");
    setOfflineLoadMessage("加载完成");
  };


  const handleNewChat = async (): Promise<void> => {
    resetChatState();
    if (isOfflineModelId(selectedModel)) {
      clearOfflineModelContext(selectedModel);
    } else {
      clearChatState();
    }
    try {
      const result = await createChatSession(bridgeUrl, bridgeToken);
      setSessionId(result.sessionId);
      setConnectionError(null);
    } catch {
      setSessionId(null);
    }
  };


  const selectedModelRawLabel =
    compressedModels.models.find((item) => item.id === selectedModel)?.label
      ?? models.find((item) => item.id === selectedModel)?.label
      ?? (selectedModel || "Agent");
  const selectedModelLabel = shortenModelLabel(
    selectedModelRawLabel,
    selectedModel || undefined,
    offlineDisplayAuthors,
  );


  const handleStreamEvent = (event: { type: string; text?: string; data?: Record<string, unknown> }): void => {
    if (event.type === "thinking") {
      setIsThinking(true);
      if (offlineModelSelected && event.data?.source === "offline_local_llm") {
        const status = typeof event.data.status === "string" ? event.data.status : "";
        const detail = typeof event.data.detail === "string" ? event.data.detail : "";
        if (status === "loading" || status === "idle") {
          const parts = [detail || "正在加载本地模型…"];
          if (typeof event.data.mode === "string" && event.data.mode === "mixed") {
            parts.push("混合模式（GPU + CPU 内存）");
          }
          if (typeof event.data.ggufGb === "number") {
            parts.push(`GGUF 约 ${event.data.ggufGb.toFixed(1)} GB`);
          }
          setOfflineLoadPhase("loading");
          setOfflineLoadMessage(parts.join("；"));
        }
      }
      return;
    }
    if (event.type === "error" && event.text) {
      setIsThinking(false);
      const formatted = formatLocalLlmError(event.text);
      stderrBufferRef.current = formatted;
      if (offlineModelSelected) {
        revertOfflineTopAfterChatFailure();
      }
      return;
    }
    if (event.type === "stderr" && event.text) {
      setIsThinking(false);
      stderrBufferRef.current = `${stderrBufferRef.current}${event.text}`.trim();
      return;
    }
    if (event.type === "assistant" && event.text) {
      setIsThinking(false);
      assistantBufferRef.current = mergeAssistantStreamText(assistantBufferRef.current, event.text);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          return [...prev.slice(0, -1), { ...last, content: assistantBufferRef.current, modelLabel: last.modelLabel ?? currentAssistantLabelRef.current }];
        }
        return [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: assistantBufferRef.current,
            createdAt: new Date().toISOString(),
            modelLabel: currentAssistantLabelRef.current,
          },
        ];
      });
    }
    if (event.type === "result" && event.text) {
      setIsThinking(false);
      assistantBufferRef.current = event.text;
      const isFailure = /失败|错误|不足|未找到|未运行|超时|OOM|sidecar/i.test(event.text);
      if (isFailure) {
        if (offlineModelSelected) {
          revertOfflineTopAfterChatFailure();
        }
      } else if (offlineModelSelected) {
        setOfflineLoadPhase("ready");
        setOfflineLoadMessage("加载完成");
      }
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          return [...prev.slice(0, -1), { ...last, content: event.text ?? "", modelLabel: last.modelLabel ?? currentAssistantLabelRef.current }];
        }
        if (event.text) {
          return [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: event.text,
              createdAt: new Date().toISOString(),
              modelLabel: currentAssistantLabelRef.current,
            },
          ];
        }
        return prev;
      });
    }
    if (event.type === "run_finished") {
      if (runFinishedRef.current) {
        return;
      }
      runFinishedRef.current = true;
      sseCloseRef.current = null;
      const finishedRunId = currentRunIdRef.current;
      currentRunIdRef.current = null;
      const exitCode = typeof event.data?.exitCode === "number" ? event.data.exitCode : null;
      const cancelled = event.data?.cancelled === true;
      if (!assistantBufferRef.current && stderrBufferRef.current) {
        appendAssistantError(formatLocalLlmError(stderrBufferRef.current));
      } else if (!assistantBufferRef.current && exitCode !== null && exitCode !== 0) {
        appendAssistantError(`CLI 运行失败（exit=${exitCode}）。`);
      }
      stderrBufferRef.current = "";
      void (async () => {
        if (finishedRunId) {
          await alignAssistantWithBridgeFinalText(finishedRunId);
        }
        if (!cancelled) {
          playNotificationSound();
        }
        drainSendQueue();
      })();
    }
  };


  const handleStopRun = async (): Promise<void> => {
    const runId = currentRunIdRef.current;
    sseCloseRef.current?.();
    sseCloseRef.current = null;
    sendQueueRef.current = [];
    if (runId) {
      try {
        await cancelChatRun(bridgeUrl, runId, bridgeToken);
      } catch {
        // 本地已关闭 SSE；Bridge 可能已结束 run
      }
      currentRunIdRef.current = null;
    }
    assistantBufferRef.current = "";
    stderrBufferRef.current = "";
    runInFlightRef.current = false;
    setIsSending(false);
    setIsThinking(false);
  };


  const subscribeToRun = (runId: string, activeSessionId: string): void => {
    runFinishedRef.current = false;
    currentRunIdRef.current = runId;
    setSessionId(activeSessionId);
    setConnectionError(null);
    localStorage.setItem(LATEST_RUN_ID_KEY, runId);
    sseCloseRef.current = subscribeRunEvents(bridgeUrl, runId, handleStreamEvent, (error) => {
      if (currentRunIdRef.current !== runId || runFinishedRef.current) {
        return;
      }
      const formatted = formatLocalLlmError(error.message);
      appendAssistantError(`流式连接失败：${formatted}`);
      if (offlineModelSelected) {
        revertOfflineTopAfterChatFailure();
      }
      sseCloseRef.current = null;
      currentRunIdRef.current = null;
      drainSendQueue();
    }, bridgeToken, {
      idleTimeoutMs: SSE_IDLE_TIMEOUT_MS,
      shouldContinue: () => currentRunIdRef.current === runId && !runFinishedRef.current,
    });
  };


  const startRun = async (prompt: string): Promise<void> => {
    runInFlightRef.current = true;
    runFinishedRef.current = false;
    setIsSending(true);
    setIsThinking(true);
    assistantBufferRef.current = "";
    stderrBufferRef.current = "";
    currentAssistantLabelRef.current = selectedModelLabel;
    sseCloseRef.current?.();
    try {
      const { runId, sessionId: activeSessionId } = await sendChatMessage(bridgeUrl, prompt, {
        model: selectedModel || undefined,
        modelLabel: selectedModelLabel,
        sessionId: sessionId ?? undefined,
        token: bridgeToken,
      });
      subscribeToRun(runId, activeSessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const formatted = formatLocalLlmError(message);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `发送失败：${formatted}`,
          createdAt: new Date().toISOString(),
        },
      ]);
      if (offlineModelSelected) {
        revertOfflineTopAfterChatFailure();
      } else {
        setConnectionError(formatted);
      }
      drainSendQueue();
    }
  };


  const handleAttachImage = async (file: File): Promise<void> => {
    const mime = file.type.toLowerCase();
    if (mime !== "image/jpeg" && mime !== "image/png") {
      appendAssistantError("Only JPEG and PNG images are supported.");
      return;
    }
    if (isOfflineModelId(selectedModel) && offlineLoadPhase !== "ready") {
      return;
    }
    if (runInFlightRef.current || isImageAnalyzing) {
      appendAssistantError("Wait for the current run to finish before attaching an image.");
      return;
    }
    const userIntent = input.trim();
    if (userIntent) {
      setInput("");
    }
    setIsImageAnalyzing(true);
    try {
      let activeSessionId = sessionId;
      if (!activeSessionId) {
        const created = await createChatSession(bridgeUrl, bridgeToken);
        activeSessionId = created.sessionId;
        setSessionId(activeSessionId);
      }
      const upload = await uploadChatImage(bridgeUrl, file, activeSessionId, bridgeToken);
      activeSessionId = upload.sessionId;
      setSessionId(activeSessionId);
      const imageUrl = upload.imageUrl.startsWith("http")
        ? upload.imageUrl
        : `${bridgeUrl.replace(/\/$/, "")}${upload.imageUrl}`;
      const analysis = await analyzeChatImage(bridgeUrl, {
        sessionId: activeSessionId,
        imageId: upload.imageId,
        fileName: upload.fileName,
        model: selectedModel || undefined,
        modelLabel: selectedModelLabel,
        userIntent: userIntent || undefined,
      }, bridgeToken);
      const userContent = userIntent
        ? `${userIntent}\n\n[Image analysis]\n${analysis.analysisText}`
        : `[Image analysis]\n${analysis.analysisText}`;
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "user",
          content: userContent,
          createdAt: new Date().toISOString(),
          imageUrl,
        },
      ]);
      runInFlightRef.current = true;
      setIsSending(true);
      setIsThinking(true);
      assistantBufferRef.current = "";
      stderrBufferRef.current = "";
      currentAssistantLabelRef.current = selectedModelLabel;
      sseCloseRef.current?.();
      subscribeToRun(analysis.runId, analysis.sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendAssistantError(`Image attach failed: ${message}`);
      setConnectionError(message);
    } finally {
      setIsImageAnalyzing(false);
    }
  };


  const offlineModelSelected = isOfflineModelId(selectedModel);
  const offlineModelReady = !offlineModelSelected || offlineLoadPhase === "ready";


  const handleComposerAction = (): void => {
    if (isSending) {
      void handleStopRun();
      return;
    }
    void handleSend();
  };


  const handleSend = async (): Promise<void> => {
    const prompt = input.trim();
    if (!prompt) {
      return;
    }
    if (runInFlightRef.current) {
      return;
    }
    if (offlineModelSelected && (offlineLoadPhase === "error" || !offlineModelReady)) {
      return;
    }
    setInput("");
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMessage]);
    await startRun(prompt);
  };


  const offlineStatusLine = offlineModelSelected
    ? formatOfflineLoadStatus({
      phase: offlineLoadPhase,
      message: offlineLoadMessage,
      error: offlineLoadPhase === "error" ? offlineLoadMessage : undefined,
    })
    : null;


  const showTypingIndicator = isSending && isThinking && (
    isThinking
    || messages.length === 0
    || messages[messages.length - 1]?.role !== "assistant"
    || !messages[messages.length - 1]?.content
  );


  return (
    <>
      <section className="chat-panel">
        <div className="toolbar">
          <label className="model-select">
            <span className="model-select-label">模型</span>
            <select
              value={selectedModel}
              onChange={(event) => handleModelChange(event.target.value)}
              disabled={isSending || models.length === 0}
            >
              {compressedModels.models.length === 0 ? (
                <option value="">加载中…</option>
              ) : (
                compressedModels.models.map((model) => (
                  model.kind === "separator" ? (
                    <option key={model.id} value="" disabled>{model.label}</option>
                  ) : (
                    <option key={model.id} value={model.id}>
                      {model.label}{model.isDefault ? " (默认)" : ""}
                    </option>
                  )
                ))
              )}
            </select>
          </label>
          <button type="button" className="btn-secondary" onClick={() => void handleNewChat()} disabled={isSending}>
            新对话
          </button>
        </div>
        {modelSwitchNotice && (
          <p className="config-save-toast" role="status">{modelSwitchNotice}</p>
        )}
        {offlineModelSelected && offlineStatusLine && (
          <p
            className={
              offlineLoadPhase === "error"
                ? "config-error"
                : offlineLoadPhase === "ready"
                  ? "config-save-toast"
                  : "config-save-status-dirty"
            }
            role="status"
          >
            {offlineStatusLine}
          </p>
        )}
        {connectionError && (
          <p className="config-error">
            {isLocalWebWithRemoteBridge(bridgeUrl)
              ? `本机页面不应使用远程 Bridge 地址（当前：${bridgeUrl}）。请到“本地 → 配置”将 Bridge URL 改为 http://127.0.0.1:4321，并确认 run.bat 已启动 Bridge。`
              : isLocalBridgeUrl(bridgeUrl) || isLocalWebOrigin()
                ? `Bridge 连接异常：${connectionError}。请确认 Bridge 已启动（默认 http://127.0.0.1:4321）。`
                : `远程 Bridge 连接异常：${connectionError}。请在“本地 → 配置”中确认 Bridge URL 和当天口令。`}
          </p>
        )}
        {!bridgeToken && !isLocalBridgeUrl(bridgeUrl) && !isLocalWebOrigin() && (
          <p className="config-hint">
            当前 Bridge URL 不是本机地址。请先在“本地 → 配置”里输入当天口令，再开始聊天。
          </p>
        )}
        <div
          ref={messagesRef}
          className="messages"
          onPointerDown={handleMessagesPointerDown}
          onTouchStart={handleMessagesTouchStart}
        >
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              onSpeakToggle={toggleSpeak}
              isSpeaking={speakingKey === message.id}
              agentLabel={message.modelLabel || selectedModelLabel}
              agentLabelTitle={selectedModelRawLabel}
              isFocused={focusedMessageId === message.id}
              onAttachImage={message.role === "assistant" ? (picked) => void handleAttachImage(picked) : undefined}
              imageAttachBusy={isImageAnalyzing}
              imageAttachDisabled={isSending && !isImageAnalyzing}
            />
          ))}
          {showTypingIndicator && (
            <div className="bubble-row bubble-row-assistant bubble-typing" aria-live="polite" aria-label={`${currentAssistantLabelRef.current} 正在输入`}>
              <div className="bubble-model-pill bubble-model-pill-static" title={selectedModelRawLabel} aria-hidden="true">
                <span className="bubble-model-pill-label">{currentAssistantLabelRef.current}</span>
              </div>
              <div className="bubble-main">
                <div className="bubble bubble-assistant bubble-assistant-typing">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} className="messages-anchor" />
        </div>
        <div className="composer input-area">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onInput={() => resizeComposer()}
            placeholder="输入消息…（本地历史：帮我找之前关于端口的对话；联网：/websearch 关键词 或 网上搜一下…）"
            rows={4}
          />
          <button
            type="button"
            className={isSending ? "composer-send send-stop" : "composer-send"}
            onClick={handleComposerAction}
            disabled={(!offlineModelReady && offlineLoadPhase !== "loading") || offlineLoadPhase === "error" || (!isSending && !input.trim())}
            aria-label={isSending ? "停止生成" : "发送消息"}
          >
            {isSending ? "停止" : offlineModelSelected && offlineLoadPhase === "loading" ? "模型加载中…" : "发送"}
          </button>
        </div>
      </section>
    </>
  );
}
