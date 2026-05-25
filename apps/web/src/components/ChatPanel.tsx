import { useEffect, useRef, useState } from "react";
import type { ChatMessage, ModelInfo } from "@chatting-cursor/shared";
import {
  createChatSession,
  fetchModels,
  mergeAssistantStreamText,
  sendChatMessage,
  subscribeRunEvents,
} from "../api/bridge";
import { clearChatState, loadChatState, saveChatState } from "../chatPersistence";
import { useSpeech } from "../hooks/useSpeech";
import { MessageBubble } from "./MessageBubble";


const LATEST_RUN_ID_KEY = "latestRunId";


interface ChatPanelProps {
  bridgeUrl: string;
}


const MODEL_STORAGE_KEY = "selectedModel";


/** 最小聊天面板 */
export function ChatPanel({ bridgeUrl }: ChatPanelProps) {
  const restoredState = loadChatState();
  const [messages, setMessages] = useState<ChatMessage[]>(() => restoredState?.messages ?? []);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState(
    () => restoredState?.selectedModel ?? localStorage.getItem(MODEL_STORAGE_KEY) ?? "",
  );
  const [sessionId, setSessionId] = useState<string | null>(() => restoredState?.sessionId ?? null);
  const assistantBufferRef = useRef("");
  const sseCloseRef = useRef<(() => void) | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const { speak } = useSpeech();


  useEffect(() => {
    let cancelled = false;
    const loadModels = async (): Promise<void> => {
      try {
        const result = await fetchModels(bridgeUrl);
        if (cancelled) {
          return;
        }
        setModels(result.models);
        const stored = localStorage.getItem(MODEL_STORAGE_KEY);
        const defaultModel = result.models.find((item) => item.isDefault)?.id ?? result.models[0]?.id ?? "";
        if (stored && result.models.some((item) => item.id === stored)) {
          setSelectedModel(stored);
        } else if (defaultModel) {
          setSelectedModel(defaultModel);
        }
      } catch {
        // 模型列表加载失败时保留当前选择
      }
    };
    void loadModels();
    return () => {
      cancelled = true;
    };
  }, [bridgeUrl]);


  useEffect(() => {
    let cancelled = false;
    const initSession = async (): Promise<void> => {
      if (sessionId) {
        return;
      }
      try {
        const result = await createChatSession(bridgeUrl);
        if (!cancelled) {
          setSessionId(result.sessionId);
        }
      } catch {
        // 会话初始化失败，发送时会再次创建
      }
    };
    void initSession();
    return () => {
      cancelled = true;
      sseCloseRef.current?.();
    };
  }, [bridgeUrl, sessionId]);


  useEffect(() => {
    saveChatState({ messages, sessionId, selectedModel });
    if (selectedModel) {
      localStorage.setItem(MODEL_STORAGE_KEY, selectedModel);
    }
  }, [messages, sessionId, selectedModel]);


  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isSending, isThinking]);


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
      const result = await createChatSession(bridgeUrl);
      setSessionId(result.sessionId);
    } catch {
      setSessionId(null);
    }
  };


  const selectedModelLabel = models.find((item) => item.id === selectedModel)?.label ?? (selectedModel || "Agent");


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
          return [...prev.slice(0, -1), { ...last, content: assistantBufferRef.current }];
        }
        return [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: assistantBufferRef.current,
            createdAt: new Date().toISOString(),
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
          return [...prev.slice(0, -1), { ...last, content: event.text ?? "" }];
        }
        if (event.text) {
          return [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: event.text,
              createdAt: new Date().toISOString(),
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
        sessionId: sessionId ?? undefined,
      });
      setSessionId(activeSessionId);
      localStorage.setItem(LATEST_RUN_ID_KEY, runId);
      sseCloseRef.current = subscribeRunEvents(bridgeUrl, runId, handleStreamEvent, () => {
        setIsSending(false);
        setIsThinking(false);
        sseCloseRef.current = null;
      });
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
        <div className="messages">
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              onSpeak={speak}
              agentLabel={selectedModelLabel}
            />
          ))}
          {showTypingIndicator && (
            <div className="bubble-row bubble-row-assistant bubble-typing" aria-live="polite" aria-label={`${selectedModelLabel} 正在输入`}>
              <div className="bubble-avatar bubble-avatar-agent" title={selectedModelLabel} aria-hidden="true">
                {selectedModelLabel.slice(0, 1)}
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
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="输入消息…（例如：帮我找之前关于端口的对话）"
            rows={3}
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
