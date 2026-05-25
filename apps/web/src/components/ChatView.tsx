import { ChatPanel } from "./ChatPanel";


interface ChatViewProps {
  bridgeUrl: string;
  bridgeToken: string;
}


/** 纯聊天视图（无本地导航链接） */
export function ChatView({ bridgeUrl, bridgeToken }: ChatViewProps) {
  return (
    <section id="chat-view" className="app-view chat-view" aria-label="聊天">
      <ChatPanel bridgeUrl={bridgeUrl} bridgeToken={bridgeToken} />
    </section>
  );
}
