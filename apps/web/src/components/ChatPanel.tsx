import { useCallback, useEffect, useRef, useState } from "react";
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
  const currentAssistantLabelRef = useRef("Agent");
  const sseCloseRef = useRef<(() => void) | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { speak } = useSpeech();


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
      try {
        const result = await fetchModels(bridgeUrl, bridgeToken);
        if (cancelled) {
          return;
        }
        setConnectionError(null);
        setModels(result.models);
        const stored = localStorage.getItem(MODEL_STORAGE_KEY);
        const defaultModel = result.models.find((item) => item.isDefault)?.id ?? result.models[0]?.id ?? "";
        if (stored && result.models.some((item) => item.id === stored)) {
          setSelectedModel(stored);
        } else if (defaultModel) {
          setSelectedModel(defaultModel);
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
      if (sessionId) {
        return;
      }
      try {
        const recent = await fetchRecentChatSession(bridgeUrl, bridgeToken);
        if (!cancelled && recent) {
          setSessionId(recent.sessionId);
          setMessages(recent.messages);
          if (recent.model) {
            setSelectedModel(recent.model);
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
  }, [bridgeToken, bridgeUrl, sessionId]);


  useEffect(() => {
    saveChatState({ messages, sessionId, selectedModel });
    if (selectedModel) {
      localStorage.setItem(MODEL_STORAGE_KEY, selectedModel);
    }
  }, [messages, sessionId, selectedModel]);


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
    setMessages([]);
    setIsSending(false);
    setIsThinking(false);
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
    models.find((item) => item.id === selectedModel)?.label ?? (selectedModel || "Agent"),
  );


  const handleStreamEvent = (event: { type: string; text?: string }): void => {
    if (event.type === "thinking") {
      setIsThinking(true);
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
            模型
            <select
              value={selectedModel}
              onChange={(event) => handleModelChange(event.target.value)}
              disabled={isSending || models.length === 0}
            >
              {models.length === 0 ? (
                <option value="">加载中…</option>
              ) : (
                models.map((model) => (
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
              onSpeak={speak}
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
