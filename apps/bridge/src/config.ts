/** Bridge 服务配置 */

export interface BridgeConfig {
  host: string;
  port: number;
  publicBridgeUrl: string;
  corsOrigins: string[];
}


/** 从环境变量加载配置 */
export function loadConfig(): BridgeConfig {
  const host = process.env.BRIDGE_HOST ?? "127.0.0.1";
  const port = Number(process.env.BRIDGE_PORT ?? 4321);
  const corsRaw = process.env.BRIDGE_CORS_ORIGINS
    ?? "http://127.0.0.1:*,http://localhost:*,https://*.github.io";
  return {
    host,
    port,
    publicBridgeUrl: process.env.BRIDGE_PUBLIC_URL?.trim() || `http://${host}:${port}`,
    corsOrigins: corsRaw.split(",").map((item) => item.trim()).filter(Boolean),
  };
}


/** 判断请求来源是否允许跨域 */
export function isOriginAllowed(origin: string | undefined, corsOrigins: string[]): boolean {
  if (!origin) {
    return true;
  }
  return corsOrigins.some((pattern) => {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
      return regex.test(origin);
    }
    return pattern === origin;
  });
}


/** 解析允许写入响应头的 Origin 值 */
export function resolveCorsOrigin(origin: string | undefined, corsOrigins: string[]): string | undefined {
  if (!origin || !isOriginAllowed(origin, corsOrigins)) {
    return undefined;
  }
  return origin;
}
