import { useRef, type ChangeEvent } from "react";
import type { ChatMessage } from "@chatting-cursor/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";


interface MessageBubbleProps {
  message: ChatMessage;
  onSpeakToggle: (key: string, text: string) => void;
  isSpeaking: boolean;
  agentLabel?: string;
  isFocused?: boolean;
  onAttachImage?: (file: File) => void;
  imageAttachBusy?: boolean;
  imageAttachDisabled?: boolean;
}


/** 微信风格单条聊天气泡 */
export function MessageBubble({
  message,
  onSpeakToggle,
  isSpeaking,
  agentLabel = "Agent",
  isFocused = false,
  onAttachImage,
  imageAttachBusy = false,
  imageAttachDisabled = false,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const label = isUser ? "" : agentLabel;
  const fileInputRef = useRef<HTMLInputElement | null>(null);


  const handleModelPillClick = (): void => {
    if (!onAttachImage || imageAttachBusy || imageAttachDisabled) {
      return;
    }
    fileInputRef.current?.click();
  };


  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !onAttachImage) {
      return;
    }
    onAttachImage(file);
  };


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
            aria-label={`Read ${label} message aloud`}
            title={isSpeaking ? "Stop reading" : "Read aloud"}
            aria-pressed={isSpeaking}
            onClick={() => onSpeakToggle(message.id, message.content)}
          >
            <span aria-hidden="true">{isSpeaking ? "■" : "🔊"}</span>
          </button>
          {onAttachImage ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png"
                className="bubble-image-input"
                tabIndex={-1}
                aria-hidden="true"
                onChange={handleFileChange}
              />
              <button
                type="button"
                className={`bubble-model-pill${imageAttachBusy ? " bubble-model-pill-busy" : ""}`}
                title={imageAttachBusy ? `${label}…` : label}
                aria-label={imageAttachBusy ? `${label} busy` : label}
                disabled={imageAttachBusy || imageAttachDisabled}
                onClick={handleModelPillClick}
              >
                <span className="bubble-model-pill-label">
                  {imageAttachBusy ? `${label}…` : label}
                </span>
              </button>
            </>
          ) : (
            <div className="bubble-model-pill bubble-model-pill-static" title={label} aria-hidden="true">
              <span className="bubble-model-pill-label">{label}</span>
            </div>
          )}
        </div>
      )}
      <div className="bubble-main">
        <div className={`bubble bubble-${message.role}`}>
          <div className="bubble-text">
            {message.imageUrl && (
              <img
                className="bubble-inline-image"
                src={message.imageUrl}
                alt="Attached"
              />
            )}
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
            aria-label="Read user message aloud"
            title={isSpeaking ? "Stop reading" : "Read aloud"}
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
