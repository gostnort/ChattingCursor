/** 命名 Cloudflare 隧道：仅存浏览器本地，与手机远程 Bridge 配置分离 */

export const CLOUDFLARE_TUNNEL_STORAGE_KEY = "chattingcursor.cloudflareTunnel.v1";


export interface CloudflareTunnelLocalSettings {
  tunnelName: string;
  accountId: string;
  publicHostname: string;
  credentialsFilePath: string;
  tunnelToken: string;
}


const EMPTY: CloudflareTunnelLocalSettings = {
  tunnelName: "",
  accountId: "",
  publicHostname: "",
  credentialsFilePath: "",
  tunnelToken: "",
};


export function loadCloudflareTunnelSettings(): CloudflareTunnelLocalSettings {
  try {
    const raw = localStorage.getItem(CLOUDFLARE_TUNNEL_STORAGE_KEY);
    if (!raw) {
      return { ...EMPTY };
    }
    const parsed = JSON.parse(raw) as Partial<CloudflareTunnelLocalSettings>;
    return {
      tunnelName: parsed.tunnelName?.trim() ?? "",
      accountId: parsed.accountId?.trim() ?? "",
      publicHostname: parsed.publicHostname?.trim() ?? "",
      credentialsFilePath: parsed.credentialsFilePath?.trim() ?? "",
      tunnelToken: parsed.tunnelToken?.trim() ?? "",
    };
  } catch {
    return { ...EMPTY };
  }
}


export function saveCloudflareTunnelSettings(settings: CloudflareTunnelLocalSettings): void {
  localStorage.setItem(CLOUDFLARE_TUNNEL_STORAGE_KEY, JSON.stringify(settings));
}


export function clearCloudflareTunnelSettings(): void {
  localStorage.removeItem(CLOUDFLARE_TUNNEL_STORAGE_KEY);
}
