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
import { isOfflineModelId } from "@chatting-cursor/shared";
import {
  analyzeChatImage,
  createChatSession,
  fetchRecentChatSession,
  fetchModels,
  mergeAssistantStreamText,
  sendChatMessage,
  subscribeRunEvents,
  uploadChatImage,
  fetchOfflineModelStatus,
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


interface ChatPanelProps {
  bridgeUrl: string;
  bridgeToken: string;
}


function shortenModelLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) {
    return "Agent";
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
  const sendQueueRef = useRef<string[]>([]);
  const runInFlightRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { toggleSpeak, speakingKey } = useSpeech();
  const compressedModels = useMemo(() => compressModelOptions(models), [models]);


  useEffect(() => {
    chatSnapshotRef.current = { messages, sessionId };
  }, [messages, sessionId]);


  const applyChatSnapshot = useCallback((snapshot: { messages: ChatMessage[]; sessionId: string | null }): void => {
    sseCloseRef.current?.();
    sseCloseRef.current = null;
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
  }, [bridgeToken, bridgeUrl, persistOfflineModelContext, restoreOnlineChatFromStorage]);


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
      sseCloseRef.current?.();
    };
  }, [bridgeToken, bridgeUrl, compressedModels.aliases, models, persistOfflineModelContext, restoreOnlineChatFromStorage, sessionId]);


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
    const { modelId, resetFromOffline } = resolveModelOnReconnect(
      selectedModel,
      models,
      compressedModels.aliases,
    );
    setSelectedModel(modelId);
    if (resetFromOffline) {
      setModelSwitchNotice(OFFLINE_RESET_NOTICE);
    }
  }, [bridgeToken, bridgeUrl, compressedModels.aliases, models, persistOfflineModelContext, restoreOnlineChatFromStorage, selectedModel]);


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
    const delayTimer = window.setTimeout(() => {
      if (offlineWarmupGenerationRef.current !== generation) {
        return;
      }
      setOfflineLoadPhase("loading");
      setOfflineLoadMessage("正在加载本地模型，请稍候…");
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
              setOfflineLoadMessage(status.error ?? status.message ?? "本地模型加载失败");
              return;
            }
            if (status.message) {
              setOfflineLoadMessage(status.message);
            }
          })
          .catch(() => {
            // 轮询失败时保留当前提示，等待 warmup 返回
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
          setOfflineLoadMessage(result.error ?? result.message ?? "本地模型未就绪");
        })
        .catch((error: unknown) => {
          if (offlineWarmupGenerationRef.current !== generation) {
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          setOfflineLoadPhase("error");
          setOfflineLoadMessage(message);
        })
        .finally(() => {
          if (pollTimer !== undefined) {
            window.clearInterval(pollTimer);
          }
        });
    }, 1000);
    return () => {
      window.clearTimeout(delayTimer);
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
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


  const selectedModelLabel = shortenModelLabel(
    compressedModels.models.find((item) => item.id === selectedModel)?.label
      ?? models.find((item) => item.id === selectedModel)?.label
      ?? (selectedModel || "Agent"),
  );


  const handleStreamEvent = (event: { type: string; text?: string; data?: Record<string, unknown> }): void => {
    if (event.type === "thinking") {
      setIsThinking(true);
      return;
    }
    if ((event.type === "stderr" || event.type === "error") && event.text) {
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
      sseCloseRef.current = null;
      const exitCode = typeof event.data?.exitCode === "number" ? event.data.exitCode : null;
      if (!assistantBufferRef.current && stderrBufferRef.current) {
        appendAssistantError(`CLI 运行失败：${stderrBufferRef.current}`);
      } else if (!assistantBufferRef.current && exitCode !== null && exitCode !== 0) {
        appendAssistantError(`CLI 运行失败（exit=${exitCode}）。`);
      }
      stderrBufferRef.current = "";
      playNotificationSound();
      drainSendQueue();
    }
  };


  const subscribeToRun = (runId: string, activeSessionId: string): void => {
    setSessionId(activeSessionId);
    setConnectionError(null);
    localStorage.setItem(LATEST_RUN_ID_KEY, runId);
    sseCloseRef.current = subscribeRunEvents(bridgeUrl, runId, handleStreamEvent, (error) => {
      appendAssistantError(`Stream connection failed: ${error.message}`);
      setConnectionError(error.message);
      sseCloseRef.current = null;
      drainSendQueue();
    }, bridgeToken);
  };


  const startRun = async (prompt: string): Promise<void> => {
    runInFlightRef.current = true;
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
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Send failed: ${message}`,
          createdAt: new Date().toISOString(),
        },
      ]);
      setConnectionError(message);
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
      appendAssistantError(offlineLoadMessage ?? "本地模型尚未加载完成，请稍候。");
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


  const handleSend = async (): Promise<void> => {
    const prompt = input.trim();
    if (!prompt) {
      return;
    }
    if (offlineModelSelected && !offlineModelReady) {
      appendAssistantError(offlineLoadMessage ?? "本地模型尚未加载完成，请稍候或检查「本地 → 本地模型」中的权重与 Python 依赖。");
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
    if (runInFlightRef.current) {
      sendQueueRef.current.push(prompt);
      return;
    }
    await startRun(prompt);
  };


  const showTypingIndicator = isSending && (
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
        {offlineModelSelected && offlineLoadMessage && (
          <p
            className={offlineLoadPhase === "error" ? "config-error" : "config-save-toast"}
            role="status"
          >
            {offlineLoadMessage}
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
              isFocused={focusedMessageId === message.id}
              onAttachImage={message.role === "assistant" ? (picked) => void handleAttachImage(picked) : undefined}
              imageAttachBusy={isImageAnalyzing}
              imageAttachDisabled={isSending && !isImageAnalyzing}
            />
          ))}
          {showTypingIndicator && (
            <div className="bubble-row bubble-row-assistant bubble-typing" aria-live="polite" aria-label={`${currentAssistantLabelRef.current} 正在输入`}>
              <div className="bubble-model-pill bubble-model-pill-static" title={currentAssistantLabelRef.current} aria-hidden="true">
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
            className="composer-send"
            onClick={() => void handleSend()}
            disabled={!input.trim() || !offlineModelReady || isSending}
          >
            {isSending ? "运行中…" : offlineModelSelected && offlineLoadPhase === "loading" ? "模型加载中…" : "发送"}
          </button>
        </div>
      </section>
    </>
  );
}
