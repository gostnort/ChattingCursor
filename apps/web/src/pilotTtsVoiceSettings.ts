/** PilotTTS 语气标签（与 spec FR-013 / upstream 一致） */
export const PILOT_TTS_EMOTION_OPTIONS = [
  { value: "", label: "默认（不指定）" },
  { value: "happy", label: "happy（开心）" },
  { value: "sad", label: "sad（悲伤）" },
  { value: "angry", label: "angry（愤怒）" },
  { value: "surprise", label: "surprise（惊讶）" },
  { value: "fear", label: "fear（恐惧）" },
  { value: "disgust", label: "disgust（厌恶）" },
  { value: "serious", label: "serious（严肃）" },
  { value: "concern", label: "concern（关切）" },
  { value: "blue", label: "blue（低落）" },
  { value: "disdain", label: "disdain（轻蔑）" },
  { value: "neutral", label: "neutral（中性）" },
  { value: "psychology", label: "psychology（心理）" },
  { value: "unknown", label: "unknown（未知）" },
] as const;


/** PilotTTS 方言代码（与 spec FR-013 一致） */
export const PILOT_TTS_DIALECT_OPTIONS = [
  { value: "", label: "默认普通话" },
  { value: "zh-dongbei", label: "zh-dongbei（东北）" },
  { value: "zh-shandong", label: "zh-shandong（山东）" },
  { value: "zh-henan", label: "zh-henan（河南）" },
  { value: "zh-shanxi", label: "zh-shanxi（山西）" },
  { value: "zh-minnan", label: "zh-minnan（闽南）" },
  { value: "zh-gansu", label: "zh-gansu（甘肃）" },
  { value: "zh-ningxia", label: "zh-ningxia（宁夏）" },
  { value: "zh-shanghai", label: "zh-shanghai（上海）" },
  { value: "zh-chongqing", label: "zh-chongqing（重庆）" },
  { value: "zh-hubei", label: "zh-hubei（湖北）" },
  { value: "zh-hunan", label: "zh-hunan（湖南）" },
  { value: "zh-jiangxi", label: "zh-jiangxi（江西）" },
  { value: "zh-guizhou", label: "zh-guizhou（贵州）" },
  { value: "zh-yunnan", label: "zh-yunnan（云南）" },
] as const;


export type PilotTtsVoiceDefaults = {
  promptWavPath: string;
  emotion: string;
  language: string;
};


function isAbsoluteFilePath(filePath: string): boolean {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return true;
  }
  if (trimmed.startsWith("/")) {
    return true;
  }
  return /^[A-Za-z]:[\\/]/.test(trimmed);
}


function hasSupportedPromptAudioSuffix(filePath: string): boolean {
  const normalized = filePath.trim().toLowerCase();
  return normalized.endsWith(".wav") || normalized.endsWith(".mp3");
}


/** 校验默认音色路径；空字符串表示清除；非空须为绝对路径且后缀 .wav/.mp3 */
export function validatePilotTtsPromptWavPath(filePath: string): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return null;
  }
  if (!isAbsoluteFilePath(trimmed)) {
    return "音色参考音频须为绝对路径（如 C:\\voice\\ref.wav 或 /home/user/ref.mp3）。";
  }
  if (!hasSupportedPromptAudioSuffix(trimmed)) {
    return "音色参考音频后缀须为 .wav 或 .mp3。";
  }
  return null;
}


/** 从调度设置提取朗读默认字段 */
export function extractPilotTtsVoiceDefaults(settings: {
  pilotTtsPromptWavPath?: string;
  pilotTtsDefaultEmotion?: string;
  pilotTtsDefaultLanguage?: string;
}): PilotTtsVoiceDefaults {
  return {
    promptWavPath: settings.pilotTtsPromptWavPath?.trim() ?? "",
    emotion: settings.pilotTtsDefaultEmotion?.trim() ?? "",
    language: settings.pilotTtsDefaultLanguage?.trim() ?? "",
  };
}


/** 构建 Bridge /tts/synthesize 请求体（省略空字段） */
export function buildPilotTtsSynthesizeBody(
  text: string,
  defaults: PilotTtsVoiceDefaults,
): Record<string, string> {
  const body: Record<string, string> = { text };
  if (defaults.promptWavPath) {
    body.promptWav = defaults.promptWavPath;
  }
  if (defaults.emotion) {
    body.emotion = defaults.emotion;
  }
  if (defaults.language) {
    body.language = defaults.language;
  }
  return body;
}
