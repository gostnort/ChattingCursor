/** GitHub Pages 线上固定地址 */
export const GITHUB_PAGES_URL = "https://gostnort.github.io/ChattingCursor/";


/** 前端是否在本机浏览器打开（127.0.0.1 / localhost） */
export function isLocalWebOrigin(): boolean {
  const host = location.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}


/** 是否运行在 GitHub Pages 生产环境 */
export function isGitHubPages(): boolean {
  return location.hostname === "gostnort.github.io";
}
