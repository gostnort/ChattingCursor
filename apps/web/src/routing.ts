/** 应用顶层模式 */
export type AppMode = "chat" | "local";


/** 本地模式子页 */
export type LocalSub = "config" | "cli" | "knowledge" | "models" | "tts";


export interface AppRoute {
  mode: AppMode;
  localSub: LocalSub;
}


/** 从 Vite base 得到应用根路径（含尾部斜杠） */
export function getAppBase(): string {
  const base = import.meta.env.BASE_URL || "/";
  return base.endsWith("/") ? base : `${base}/`;
}


/** 解析 pathname 与 hash，兼容旧 /config、/terminal */
export function parseRoute(pathname: string, hash: string): AppRoute {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized.endsWith("/config")) {
    return { mode: "local", localSub: "config" };
  }
  if (normalized.endsWith("/terminal")) {
    return { mode: "local", localSub: "cli" };
  }
  const hashMatch = hash.match(/^#?\/?local\/(config|cli|knowledge|models)\/?$/i);
  if (hashMatch) {
    return { mode: "local", localSub: hashMatch[1] as LocalSub };
  }
  if (/\/local\/config\/?$/i.test(normalized)) {
    return { mode: "local", localSub: "config" };
  }
  if (/\/local\/cli\/?$/i.test(normalized)) {
    return { mode: "local", localSub: "cli" };
  }
  if (/\/local\/knowledge\/?$/i.test(normalized)) {
    return { mode: "local", localSub: "knowledge" };
  }
  if (/\/local\/models\/?$/i.test(normalized)) {
    return { mode: "local", localSub: "models" };
  }
  if (/\/local\/tts\/?$/i.test(normalized)) {
    return { mode: "local", localSub: "tts" };
  }
  return { mode: "chat", localSub: "config" };
}


/** 构建 canonical pathname（不含 query/hash） */
export function buildPath(route: AppRoute): string {
  const base = getAppBase();
  if (route.mode === "chat") {
    return base;
  }
  return `${base}local/${route.localSub}`;
}


/** 将旧 /config、/terminal 或 hash 路由规范化为 pathname */
export function normalizeLocation(route: AppRoute): void {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const isLegacy = path.endsWith("/config") || path.endsWith("/terminal");
  const hasHashRoute = /^#?\/?local\/(config|cli|knowledge|models|tts)/i.test(window.location.hash);
  if (isLegacy || hasHashRoute) {
    window.history.replaceState(null, "", buildPath(route) + window.location.search);
  }
}
