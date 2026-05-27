import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { getChattingCursorHomeDir, getCloudflareTunnelConfigPath } from "../paths.js";


export interface CloudflareTunnelConfigFile {
  tunnelName?: string;
  accountId?: string;
  publicHostname?: string;
  credentialsFilePath?: string;
  tunnelToken?: string;
}


/** 同步读取命名隧道配置 */
export function readCloudflareTunnelConfigSync(): CloudflareTunnelConfigFile {
  const configPath = getCloudflareTunnelConfigPath();
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as CloudflareTunnelConfigFile;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}


/** 是否已配置命名隧道（run-all 会走 cloudflared tunnel run） */
export function isNamedCloudflareTunnelConfigured(): boolean {
  const fromEnvName = process.env.CHATTINGCURSOR_TUNNEL_NAME?.trim();
  const fromEnvHost = process.env.CHATTINGCURSOR_TUNNEL_HOSTNAME?.trim();
  if (fromEnvName && fromEnvHost) {
    return true;
  }
  const cfg = readCloudflareTunnelConfigSync();
  return Boolean(cfg.tunnelName?.trim() && cfg.publicHostname?.trim());
}


/** 解析对外 HTTPS 地址 */
export function resolveNamedTunnelPublicBridgeUrl(): string | null {
  const fromEnvHost = process.env.CHATTINGCURSOR_TUNNEL_HOSTNAME?.trim();
  if (fromEnvHost) {
    const host = fromEnvHost.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    return host ? `https://${host}` : null;
  }
  const hostname = readCloudflareTunnelConfigSync().publicHostname?.trim();
  if (!hostname) {
    return null;
  }
  const host = hostname.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return host ? `https://${host}` : null;
}


/** 持久化命名隧道配置 */
export async function saveCloudflareTunnelConfig(
  input: CloudflareTunnelConfigFile,
): Promise<CloudflareTunnelConfigFile> {
  const tunnelName = input.tunnelName?.trim() ?? "";
  const publicHostname = input.publicHostname?.trim() ?? "";
  const accountId = input.accountId?.trim() ?? "";
  const credentialsFilePath = input.credentialsFilePath?.trim() ?? "";
  const tunnelToken = input.tunnelToken?.trim() ?? "";
  const next: CloudflareTunnelConfigFile = {
    tunnelName,
    accountId,
    publicHostname,
    credentialsFilePath,
    tunnelToken,
  };
  await mkdir(getChattingCursorHomeDir(), { recursive: true });
  const configPath = getCloudflareTunnelConfigPath();
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}


/** 异步读取（API 用） */
export async function readCloudflareTunnelConfig(): Promise<CloudflareTunnelConfigFile> {
  const configPath = getCloudflareTunnelConfigPath();
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as CloudflareTunnelConfigFile;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}
