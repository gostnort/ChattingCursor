/** 本地 LLM 常见错误类别 */
export type LocalLlmErrorKind =
  | "vram_insufficient"
  | "weights_missing"
  | "cuda_missing"
  | "binary_mismatch"
  | "sidecar_down"
  | "load_timeout"
  | "preflight_failed"
  | "oom"
  | "unknown";


const VRAM_PATTERNS = [
  /显存|内存不足|vram|insufficient.*memory|cuda.*memory|out of memory|oom|cudamalloc|memory allocation/i,
  /gguf.*gb.*显存|远超.*gpu/i,
];


const WEIGHTS_PATTERNS = [
  /未找到.*gguf|missing.*weight|权重不完整|weights.*missing|未在.*找到.*\.gguf|no such file.*gguf/i,
];


const CUDA_PATTERNS = [
  /cuda|cublas|libcublas|libcuda|dll load failed|could not load.*llama|llama_cpp.*error|gpu.*not found|no module named ['"]llama_cpp|llama_cpp or inference dependencies missing/i,
];


const BINARY_MISMATCH_PATTERNS = [
  /0xc000001d|status_illegal_instruction|illegal instruction|-1073741795|指令集.*不匹配|cuda\/cpu.*不匹配/i,
];


const SIDECAR_PATTERNS = [
  /sidecar|4322|未响应.*health|connection refused|econnrefused|fetch failed|推理.*未运行|进程.*未响应/i,
];


const TIMEOUT_PATTERNS = [
  /超时|timeout|timed out|未加载完成/i,
];


const PREFLIGHT_PATTERNS = [
  /preflight|strict_preflight|q4_k_m|量化/i,
];


/** 识别本地 LLM 错误类型 */
export function classifyLocalLlmError(raw: string): LocalLlmErrorKind {
  const text = raw.trim();
  if (!text) {
    return "unknown";
  }
  if (PREFLIGHT_PATTERNS.some((pattern) => pattern.test(text))) {
    if (/显存|内存|gguf.*gb/i.test(text)) {
      return "preflight_failed";
    }
  }
  if (VRAM_PATTERNS.some((pattern) => pattern.test(text))) {
    return "vram_insufficient";
  }
  if (BINARY_MISMATCH_PATTERNS.some((pattern) => pattern.test(text))) {
    return "binary_mismatch";
  }
  if (WEIGHTS_PATTERNS.some((pattern) => pattern.test(text))) {
    return "weights_missing";
  }
  if (CUDA_PATTERNS.some((pattern) => pattern.test(text))) {
    return "cuda_missing";
  }
  if (SIDECAR_PATTERNS.some((pattern) => pattern.test(text))) {
    return "sidecar_down";
  }
  if (TIMEOUT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "load_timeout";
  }
  if (/oom|out of memory/i.test(text)) {
    return "oom";
  }
  return "unknown";
}


function isAlreadyActionableChinese(message: string): boolean {
  if (!/[\u4e00-\u9fff]/.test(message)) {
    return false;
  }
  return /请|建议|设置|检查|改用|确认|安装/.test(message);
}


const ERROR_HEADLINES: Record<LocalLlmErrorKind, string> = {
  vram_insufficient: "显存或系统内存不足，无法加载当前 GGUF 模型。",
  weights_missing: "未找到或未完整安装 GGUF 权重文件。",
  cuda_missing: "CUDA / GPU 运行库不可用，llama.cpp 无法使用显卡加速。",
  binary_mismatch: "llama.cpp 指令集或 CUDA/CPU 版本不匹配（STATUS_ILLEGAL_INSTRUCTION）。",
  sidecar_down: "本地推理 sidecar（端口 4322）未运行或无响应。",
  load_timeout: "模型加载超时，可能因 GGUF 过大或显存不足。",
  preflight_failed: "加载前检查未通过，当前硬件/配置无法安全加载该模型。",
  oom: "加载或推理时内存耗尽（OOM）。",
  unknown: "本地模型运行失败。",
};


const ERROR_FIXES: Record<LocalLlmErrorKind, string> = {
  vram_insufficient: "建议：改用 Q4_K_M 量化（约 15 GB）、设置 LOCAL_LLM_N_GPU_LAYERS=35 启用混合模式，或换用更小模型（如 gemma-4-E4B）。",
  weights_missing: "建议：打开「本地 → 本地模型」安装 GGUF，或运行 local_llm/server/install.bat。",
  cuda_missing: "建议：安装 NVIDIA 驱动与 CUDA；若无独显，设置 LOCAL_LLM_N_GPU_LAYERS=0 使用纯 CPU。",
  binary_mismatch: "建议：运行 local_llm/server/install.bat 重装 cu124 wheel；确保 Bridge 启动时 PATH 含 NVIDIA DLL；若无独显，设置 LOCAL_LLM_N_GPU_LAYERS=0。",
  sidecar_down: "建议：确认 Bridge 已启动且 LOCAL_LLM_MANAGED=1；或手动运行 local_llm/server/llm_server.py。",
  load_timeout: "建议：改用更小量化、增大 LOCAL_LLM_LOAD_TIMEOUT_MS，或设置 LOCAL_LLM_N_GPU_LAYERS=35。",
  preflight_failed: "建议：改用 Q4_K_M 量化或更小模型；混合模式可设 LOCAL_LLM_N_GPU_LAYERS=35。",
  oom: "建议：关闭其他占内存程序、改用更小量化，或减小 LOCAL_LLM_N_CTX。",
  unknown: "建议：查看 Bridge 日志与「本地 → 本地模型」中的权重/依赖状态。",
};


/** 将 fetch/网络底层错误转为更可读的中文片段 */
function humanizeFetchFailure(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (/^fetch failed$/i.test(trimmed)) {
    return "无法连接本地推理 sidecar（fetch failed，端口 4322 无响应）";
  }
  if (/ECONNREFUSED|connection refused/i.test(trimmed)) {
    return "连接被拒绝（127.0.0.1:4322 未监听）";
  }
  return trimmed;
}


/** 将原始错误映射为带修复建议的中文用户消息 */
export function formatLocalLlmError(raw: string): string {
  const trimmed = humanizeFetchFailure(raw.trim());
  if (!trimmed) {
    return `${ERROR_HEADLINES.unknown}${ERROR_FIXES.unknown}`;
  }
  if (isAlreadyActionableChinese(trimmed)) {
    return trimmed;
  }
  const kind = classifyLocalLlmError(trimmed);
  const headline = ERROR_HEADLINES[kind];
  const fix = ERROR_FIXES[kind];
  if (kind === "unknown") {
    return `${headline}${fix} 详情：${trimmed}`;
  }
  return `${headline}${fix}（${trimmed}）`;
}


/** 离线模型预热/就绪状态行文案（绿色就绪 / 红色错误） */
export function formatOfflineLoadStatus(options: {
  phase: "idle" | "waiting" | "loading" | "ready" | "error";
  message?: string | null;
  error?: string | null;
}): string | null {
  if (options.phase === "ready") {
    return options.message?.trim() || "加载完成，可以发送消息。";
  }
  if (options.phase === "error") {
    return formatLocalLlmError(options.error ?? options.message ?? "本地模型加载失败");
  }
  if (options.phase === "loading") {
    return options.message?.trim() || "正在加载本地模型，请稍候…";
  }
  if (options.phase === "waiting") {
    return options.message?.trim() || "即将开始加载本地模型…";
  }
  return options.message ?? null;
}
