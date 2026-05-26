import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ModelInfo } from "@chatting-cursor/shared";
import {
  createChatSession,
  fetchRecentChatSession,
  fetchModels,
  mergeAssistantStreamText,
  sendChatMessage,
  subscribeRunEvents,
} from "../api/bridge";
import { clearChatState, loadChatState, saveChatState } from "../chatPersistence";
import { isLocalBridgeUrl } from "../bridgeSettings";
import { useSpeech } from "../hooks/useSpeech";
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
  const assistantBufferRef = useRef("");
  const stderrBufferRef = useRef("");
  const currentAssistantLabelRef = useRef("Agent");
  const sseCloseRef = useRef<(() => void) | null>(null);
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


  const handleModelChange = (value: string): void => {
    setSelectedModel(value);
    localStorage.setItem(MODEL_STORAGE_KEY, value);
  };


  const resetChatState = (): void => {
    sseCloseRef.current?.();
    sseCloseRef.current = null;
    assistantBufferRef.current = "";
    stderrBufferRef.current = "";
    setMessages([]);
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
      setIsSending(false);
      setIsThinking(false);
      sseCloseRef.current = null;
      const exitCode = typeof event.data?.exitCode === "number" ? event.data.exitCode : null;
      if (!assistantBufferRef.current && stderrBufferRef.current) {
        appendAssistantError(`CLI 运行失败：${stderrBufferRef.current}`);
      } else if (!assistantBufferRef.current && exitCode !== null && exitCode !== 0) {
        appendAssistantError(`CLI 运行失败（exit=${exitCode}）。`);
      }
      stderrBufferRef.current = "";
    }
  };


  const handleSend = async (): Promise<void> => {
    const prompt = input.trim();
    if (!prompt || isSending) {
      return;
    }
    setIsSending(true);
    setIsThinking(true);
    setInput("");
    assistantBufferRef.current = "";
    stderrBufferRef.current = "";
    currentAssistantLabelRef.current = selectedModelLabel;
    sseCloseRef.current?.();
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMessage]);
    try {
      const { runId, sessionId: activeSessionId } = await sendChatMessage(bridgeUrl, prompt, {
        model: selectedModel || undefined,
        modelLabel: selectedModelLabel,
        sessionId: sessionId ?? undefined,
        token: bridgeToken,
      });
      setSessionId(activeSessionId);
      setConnectionError(null);
      localStorage.setItem(LATEST_RUN_ID_KEY, runId);
      sseCloseRef.current = subscribeRunEvents(bridgeUrl, runId, handleStreamEvent, () => {
        setIsSending(false);
        setIsThinking(false);
        sseCloseRef.current = null;
      }, bridgeToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `发送失败：${message}`,
          createdAt: new Date().toISOString(),
        },
      ]);
      setConnectionError(message);
      setIsSending(false);
      setIsThinking(false);
    }
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
            {isLocalBridgeUrl(bridgeUrl)
              ? `Bridge 连接异常：${connectionError}`
              : `远程 Bridge 连接异常：${connectionError}。请在“本地 → 配置”中确认 Bridge URL 和当天口令。`}
          </p>
        )}
        {!bridgeToken && !isLocalBridgeUrl(bridgeUrl) && (
          <p className="config-hint">
            当前 Bridge URL 不是本机地址。请先在“本地 → 配置”里输入当天口令，再开始聊天。
          </p>
        )}
        <div className="messages">
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              onSpeakToggle={toggleSpeak}
              isSpeaking={speakingKey === message.id}
              agentLabel={message.modelLabel || selectedModelLabel}
            />
          ))}
          {showTypingIndicator && (
            <div className="bubble-row bubble-row-assistant bubble-typing" aria-live="polite" aria-label={`${currentAssistantLabelRef.current} 正在输入`}>
              <div className="bubble-avatar bubble-avatar-agent" title={currentAssistantLabelRef.current} aria-hidden="true">
                {currentAssistantLabelRef.current}
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
            disabled={isSending}
          />
          <button
            type="button"
            className="composer-send"
            onClick={() => void handleSend()}
            disabled={isSending || !input.trim()}
          >
            {isSending ? "运行中…" : "发送"}
          </button>
        </div>
      </section>
    </>
  );
}
