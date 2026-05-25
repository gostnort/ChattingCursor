/** GitHub Pages 线上固定地址 */
export const GITHUB_PAGES_URL = "https://gostnort.github.io/ChattingCursor/";


/** 是否运行在 GitHub Pages 生产环境 */
export function isGitHubPages(): boolean {
  return location.hostname === "gostnort.github.io"
    || (import.meta.env.PROD && !location.hostname.includes("localhost"));
}
