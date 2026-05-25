import { useEffect, useRef, useState } from "react";
import type { ChatMessage, ModelInfo } from "@chatting-cursor/shared";
import {
  createChatSession,
  fetchBridgeHealth,
  fetchModels,
  mergeAssistantStreamText,
  sendChatMessage,
  subscribeRunEvents,
} from "../api/bridge";
import type { BridgeHealthResponse } from "../api/bridge";
import { TerminalPanel } from "./TerminalPanel";


interface ChatPanelProps {
  bridgeUrl: string;
}


const MODEL_STORAGE_KEY = "selectedModel";


/** 最小聊天面板 */
export function ChatPanel({ bridgeUrl }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealthResponse | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem(MODEL_STORAGE_KEY) ?? "");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const assistantBufferRef = useRef("");
  const sseCloseRef = useRef<(() => void) | null>(null);


  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      const health = await fetchBridgeHealth(bridgeUrl);
      if (!cancelled) {
        setBridgeHealth(health);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [bridgeUrl]);


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
  }, [bridgeUrl]);


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
    setActiveRunId(null);
  };


  const handleNewChat = async (): Promise<void> => {
    resetChatState();
    try {
      const result = await createChatSession(bridgeUrl);
      setSessionId(result.sessionId);
    } catch {
      setSessionId(null);
    }
  };


  const handleSend = async (): Promise<void> => {
    const prompt = input.trim();
    if (!prompt || isSending) {
      return;
    }
    setIsSending(true);
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
      setActiveRunId(runId);
      sseCloseRef.current = subscribeRunEvents(bridgeUrl, runId, (event) => {
        if (event.type === "assistant" && event.text) {
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
          sseCloseRef.current = null;
        }
      }, () => {
        setIsSending(false);
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
    }
  };


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
        <div className="status-bar">
          Bridge: {bridgeHealth === null ? "检测中…" : bridgeHealth.status === "ok" ? "在线" : "离线（请先启动 bridge）"}
          {bridgeHealth?.cli && (
            <span className="cli-status">
              {" "}· CLI: {bridgeHealth.cli.available
                ? (bridgeHealth.cli.command ?? "可用")
                : (bridgeHealth.cli.message ?? "不可用（需安装 Cursor Agent CLI 并登录）")}
            </span>
          )}
          {sessionId && <span className="session-id"> · 会话 {sessionId.slice(0, 8)}</span>}
        </div>
        <div className="messages">
          {messages.map((message) => (
            <article key={message.id} className={`message message-${message.role}`}>
              <strong>{message.role === "user" ? "你" : "Agent"}</strong>
              <pre>{message.content}</pre>
            </article>
          ))}
        </div>
        <div className="composer">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="输入消息…（例如：帮我找之前关于端口的对话）"
            rows={3}
            disabled={isSending}
          />
          <button type="button" onClick={() => void handleSend()} disabled={isSending || !input.trim()}>
            {isSending ? "运行中…" : "发送"}
          </button>
        </div>
      </section>
      <TerminalPanel bridgeUrl={bridgeUrl} runId={activeRunId} />
    </>
  );
}
