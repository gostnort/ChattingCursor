import type { SchedulerUserSettings } from "./scheduler-settings.js";


export type SynthesizeRequestBody = {
  text?: string;
  promptWav?: string;
  emotion?: string;
  language?: string;
};


export type MergedSynthesizePayload = {
  text: string;
  promptWav?: string;
  emotion?: string;
  language?: string;
};


const PROMPT_AUDIO_SUFFIXES = [".wav", ".mp3"];


/** 判断 prompt 音频路径后缀是否为 sidecar 支持的 wav/mp3 */
export function isValidPromptAudioPath(filePath: string): boolean {
  const normalized = filePath.trim().toLowerCase();
  return PROMPT_AUDIO_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}


function pickMergedField(requestValue: string | undefined, defaultValue: string): string | undefined {
  if (requestValue !== undefined) {
    const fromRequest = requestValue.trim();
    if (fromRequest) {
      return fromRequest;
    }
    return undefined;
  }
  const fromDefault = defaultValue?.trim();
  if (fromDefault) {
    return fromDefault;
  }
  return undefined;
}


/** 合并 synthesize 请求体与持久化默认，空字符串字段省略 */
export function mergeSynthesizePayload(
  body: SynthesizeRequestBody,
  settings: Pick<
    SchedulerUserSettings,
    "pilotTtsPromptWavPath" | "pilotTtsDefaultEmotion" | "pilotTtsDefaultLanguage"
  >,
): MergedSynthesizePayload {
  const text = body.text?.trim() ?? "";
  const promptWav = pickMergedField(body.promptWav, settings.pilotTtsPromptWavPath);
  const emotion = pickMergedField(body.emotion, settings.pilotTtsDefaultEmotion);
  const language = pickMergedField(body.language, settings.pilotTtsDefaultLanguage);
  const merged: MergedSynthesizePayload = { text };
  if (promptWav) {
    merged.promptWav = promptWav;
  }
  if (emotion) {
    merged.emotion = emotion;
  }
  if (language) {
    merged.language = language;
  }
  return merged;
}


/** emotion 或 dialect 合成需要 instruct 权重 */
export function requiresInstructSynthesis(payload: MergedSynthesizePayload): boolean {
  return Boolean(payload.emotion?.trim() || payload.language?.trim());
}
