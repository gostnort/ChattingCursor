import type { ChatMessage } from "@chatting-cursor/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";


interface MessageBubbleProps {
  message: ChatMessage;
  onSpeakToggle: (key: string, text: string) => void;
  isSpeaking: boolean;
  agentLabel?: string;
  isFocused?: boolean;
}


/** 微信风格单条聊天气泡 */
export function MessageBubble({ message, onSpeakToggle, isSpeaking, agentLabel = "Agent", isFocused = false }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const label = isUser ? "" : agentLabel;


  return (
    <div
      className={`bubble-row bubble-row-${message.role}${isFocused ? " bubble-row-focused" : ""}`}
      data-message-id={message.id}
    >
      {!isUser && (
        <div className="bubble-side">
          <button
            type="button"
            className={`bubble-tts${isSpeaking ? " bubble-tts-active" : ""}`}
            aria-label={`朗读${label}消息`}
            title={isSpeaking ? "停止朗读" : "朗读"}
            aria-pressed={isSpeaking}
            onClick={() => onSpeakToggle(message.id, message.content)}
          >
            <span aria-hidden="true">{isSpeaking ? "■" : "🔊"}</span>
          </button>
          <div className="bubble-avatar bubble-avatar-agent" title={label} aria-hidden="true">
            {label}
          </div>
        </div>
      )}
      <div className="bubble-main">
        <div className={`bubble bubble-${message.role}`}>
          <div className="bubble-text">
            {isUser ? (
              message.content
            ) : (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            )}
          </div>
        </div>
        {isUser && (
          <button
            type="button"
            className={`bubble-tts${isSpeaking ? " bubble-tts-active" : ""}`}
            aria-label="朗读用户消息"
            title={isSpeaking ? "停止朗读" : "朗读"}
            aria-pressed={isSpeaking}
            onClick={() => onSpeakToggle(message.id, message.content)}
          >
            <span aria-hidden="true">{isSpeaking ? "■" : "🔊"}</span>
          </button>
        )}
      </div>
    </div>
  );
}
