import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { ChatMessage, ModelInfo } from "@chatting-cursor/shared";
import {
  analyzeChatImage,
  createChatSession,
  fetchRecentChatSession,
  fetchModels,
  mergeAssistantStreamText,
  sendChatMessage,
  subscribeRunEvents,
  uploadChatImage,
} from "../api/bridge";
import { clearChatState, loadChatState, saveChatState } from "../chatPersistence";
import { isLocalBridgeUrl, isLocalWebWithRemoteBridge } from "../bridgeSettings";
import { isLocalWebOrigin } from "../environment";
import { useSpeech } from "../hooks/useSpeech";
import { playNotificationSound } from "../utils/notificationSound";
import {
  clampSelectionToFocusedBubble,
  isEditableFocusedTarget,
  selectElementText,
} from "../utils/selectBubbleText";
import { MessageBubble } from "./MessageBubble";


const LATEST_RUN_ID_KEY = "latestRunId";


interface ChatPanelProps {
  bridgeUrl: string;
  bridgeToken: string;
}


const MODEL_STORAGE_KEY = "selectedModel";


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
  const groups = new Map<string, ModelInfo[]>();
  for (const model of source) {
    const key = extractModelGroupKey(model.label);
    const group = groups.get(key) ?? [];
    group.push(model);
    groups.set(key, group);
  }
  const compressed: ModelInfo[] = [];
  const aliases = new Map<string, string>();
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
    compressed.push({
      ...representative,
      isDefault: hasDefault || representative.isDefault,
    });
    for (const item of group) {
      aliases.set(item.id, representative.id);
    }
  }
  compressed.sort((left, right) => {
    if (left.isDefault && !right.isDefault) {
      return -1;
    }
    if (!left.isDefault && right.isDefault) {
      return 1;
    }
    return normalizeModelBase(left.label).localeCompare(normalizeModelBase(right.label));
  });
  return { models: compressed, aliases };
}


/** 最小聊天面板 */
export function ChatPanel({ bridgeUrl, bridgeToken }: ChatPanelProps) {
  const restoredState = loadChatState();
  const [messages, setMessages] = useState<ChatMessage[]>(() => restoredState?.messages ?? []);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState(
    () => restoredState?.selectedModel ?? localStorage.getItem(MODEL_STORAGE_KEY) ?? "",
  );
  const [sessionId, setSessionId] = useState<string | null>(() => restoredState?.sessionId ?? null);
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
        const stored = localStorage.getItem(MODEL_STORAGE_KEY);
        const defaultModel = result.models.find((item) => item.isDefault)?.id ?? result.models[0]?.id ?? "";
        const aliasMap = compressModelOptions(result.models).aliases;
        if (stored && result.models.some((item) => item.id === stored)) {
          setSelectedModel(aliasMap.get(stored) ?? stored);
        } else if (defaultModel) {
          setSelectedModel(aliasMap.get(defaultModel) ?? defaultModel);
        }
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
  }, [bridgeToken, bridgeUrl]);


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
          setSessionId(recent.sessionId);
          setMessages(recent.messages);
          if (recent.model) {
            setSelectedModel(compressedModels.aliases.get(recent.model) ?? recent.model);
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
  }, [bridgeToken, bridgeUrl, compressedModels.aliases, sessionId]);


  useEffect(() => {
    saveChatState({ messages, sessionId, selectedModel });
    if (selectedModel) {
      localStorage.setItem(MODEL_STORAGE_KEY, selectedModel);
    }
  }, [messages, sessionId, selectedModel]);


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
      clampSelectionToFocusedBubble(focusedMessageId);
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [focusedMessageId]);


  const handleMessagesPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-message-id]");
    if (row?.dataset.messageId) {
      setFocusedMessageId(row.dataset.messageId);
      return;
    }
    setFocusedMessageId(null);
  };


  const handleModelChange = (value: string): void => {
    setSelectedModel(value);
    localStorage.setItem(MODEL_STORAGE_KEY, value);
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
    clearChatState();
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


  const handleSend = async (): Promise<void> => {
    const prompt = input.trim();
    if (!prompt) {
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
                  <option key={model.id} value={model.id}>
                    {model.label}{model.isDefault ? " (默认)" : ""}
                  </option>
                ))
              )}
            </select>
          </label>
          <button type="button" className="btn-secondary" onClick={() => void handleNewChat()} disabled={isSending}>
            新对话
          </button>
        </div>
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
        <div className="messages" onPointerDown={handleMessagesPointerDown}>
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
            placeholder="输入消息…（例如：帮我找之前关于端口的对话）"
            rows={4}
          />
          <button
            type="button"
            className="composer-send"
            onClick={() => void handleSend()}
            disabled={!input.trim()}
          >
            {isSending ? "运行中…" : "发送"}
          </button>
        </div>
      </section>
    </>
  );
}
