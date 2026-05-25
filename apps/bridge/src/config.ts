/** Bridge 服务配置 */

export interface BridgeConfig {
  host: string;
  port: number;
  corsOrigins: string[];
}


/** 从环境变量加载配置 */
export function loadConfig(): BridgeConfig {
  const corsRaw = process.env.BRIDGE_CORS_ORIGINS
    ?? "http://127.0.0.1:43210,http://localhost:43210,http://127.0.0.1:5173,http://localhost:5173,https://*.github.io";
  return {
    host: process.env.BRIDGE_HOST ?? "127.0.0.1",
    port: Number(process.env.BRIDGE_PORT ?? 4321),
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
