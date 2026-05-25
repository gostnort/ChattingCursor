import type { ChatMessage } from "@chatting-cursor/shared";


interface MessageBubbleProps {
  message: ChatMessage;
  onSpeak: (text: string) => void;
}


/** 微信风格单条聊天气泡 */
export function MessageBubble({ message, onSpeak }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const label = isUser ? "你" : "Agent";


  return (
    <div className={`bubble-row bubble-row-${message.role}`}>
      {!isUser && (
        <div className="bubble-avatar bubble-avatar-agent" aria-hidden="true">
          {label.slice(0, 1)}
        </div>
      )}
      <div className="bubble-main">
        <div className={`bubble bubble-${message.role}`}>
          <div className="bubble-text">{message.content}</div>
        </div>
        <button
          type="button"
          className="bubble-tts"
          aria-label={`朗读${label}消息`}
          title="朗读"
          onClick={() => onSpeak(message.content)}
        >
          <span aria-hidden="true">🔊</span>
        </button>
      </div>
      {isUser && (
        <div className="bubble-avatar bubble-avatar-user" aria-hidden="true">
          {label}
        </div>
      )}
    </div>
  );
}
