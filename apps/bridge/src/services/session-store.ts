import { v4 as uuidv4 } from "uuid";


/** 会话内单条消息 */
export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  modelLabel?: string;
}


/** 单个聊天会话 */
export interface ChatSession {
  sessionId: string;
  messages: SessionMessage[];
  createdAt: string;
  updatedAt: string;
  model?: string;
}


/** 内存会话存储 */
export class SessionStore {
  private sessions = new Map<string, ChatSession>();


  create(): ChatSession {
    const session: ChatSession = {
      sessionId: uuidv4(),
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }


  getOrCreate(sessionId?: string): ChatSession {
    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing) {
        return existing;
      }
      const session: ChatSession = {
        sessionId,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.sessions.set(sessionId, session);
      return session;
    }
    return this.create();
  }


  appendMessage(sessionId: string, message: SessionMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.messages.push(message);
    session.updatedAt = message.timestamp;
  }


  setModel(sessionId: string, model?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.model = model;
  }


  getRecent(): ChatSession | null {
    const sessions = [...this.sessions.values()];
    if (sessions.length === 0) {
      return null;
    }
    sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return sessions[0] ?? null;
  }
}


export const sessionStore = new SessionStore();
