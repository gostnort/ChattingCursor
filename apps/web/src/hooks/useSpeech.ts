import { useCallback, useRef, useState } from "react";
import { fetchSchedulerSettings } from "../api/bridge";
import {
  buildPilotTtsSynthesizeBody,
  extractPilotTtsVoiceDefaults,
  type PilotTtsVoiceDefaults,
} from "../pilotTtsVoiceSettings";


const TTS_CHUNK_BYTES = 1000;
const TTS_NEXT_CHUNK_DELAY_MS = 50;
const textEncoder = new TextEncoder();


/** 朗读前去掉 Markdown 符号，避免 TTS 读出星号等 */
function sanitizeTextForTts(text: string): string {
  return text.replace(/[*_`#/:]/g, "");
}


interface TtsPlayState {
  key: string;
  fullText: string;
  byteOffset: number;
}


interface TtsChunk {
  text: string;
  nextOffset: number;
}


/** 按 UTF-8 字节上限切分，保证不在多字节字符中间截断 */
function sliceTtsChunkByBytes(fullText: string, startByteOffset: number, maxBytes = TTS_CHUNK_BYTES): TtsChunk | null {
  const bytes = textEncoder.encode(fullText);
  if (startByteOffset >= bytes.length) {
    return null;
  }
  let end = Math.min(startByteOffset + maxBytes, bytes.length);
  while (end > startByteOffset) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(startByteOffset, end));
      return { text, nextOffset: end };
    } catch {
      end -= 1;
    }
  }
  return null;
}


function fullTextByteLength(fullText: string): number {
  return textEncoder.encode(fullText).length;
}


async function isPilotTtsSynthAvailable(bridgeUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${bridgeUrl}/tts/capability`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      return false;
    }
    const payload = await response.json() as { pilotSynthAvailable?: boolean };
    return payload.pilotSynthAvailable === true;
  } catch {
    return false;
  }
}


async function tryPilotTtsSynthesize(
  bridgeUrl: string,
  text: string,
  defaults: PilotTtsVoiceDefaults,
): Promise<boolean> {
  try {
    const response = await fetch(`${bridgeUrl}/tts/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPilotTtsSynthesizeBody(text, defaults)),
    });
    if (!response.ok) {
      return false;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("audio")) {
      return false;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    await audio.play();
    audio.onended = () => URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}


/** 浏览器朗读；可选 Bridge PilotTTS，失败回退 speechSynthesis */
export function useSpeech(bridgeUrl?: string) {
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const playStateRef = useRef<TtsPlayState | null>(null);
  const resumeOffsetRef = useRef(0);
  const stoppedByUserRef = useRef(false);
  const ttsDefaultsRef = useRef<PilotTtsVoiceDefaults | null>(null);
  const ttsDefaultsLoadingRef = useRef<Promise<PilotTtsVoiceDefaults> | null>(null);
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  const loadTtsDefaults = useCallback(async (url: string): Promise<PilotTtsVoiceDefaults> => {
    if (ttsDefaultsRef.current) {
      return ttsDefaultsRef.current;
    }
    if (ttsDefaultsLoadingRef.current) {
      return ttsDefaultsLoadingRef.current;
    }
    const pending = fetchSchedulerSettings(url)
      .then((bundle) => {
        const defaults = extractPilotTtsVoiceDefaults(bundle.settings);
        ttsDefaultsRef.current = defaults;
        return defaults;
      })
      .catch(() => {
        const empty: PilotTtsVoiceDefaults = { promptWavPath: "", emotion: "", language: "" };
        ttsDefaultsRef.current = empty;
        return empty;
      })
      .finally(() => {
        ttsDefaultsLoadingRef.current = null;
      });
    ttsDefaultsLoadingRef.current = pending;
    return pending;
  }, []);


  const stop = useCallback((): void => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      return;
    }
    stoppedByUserRef.current = true;
    window.speechSynthesis.cancel();
    utteranceRef.current = null;
    setSpeakingKey(null);
  }, []);


  const speakChunk = useCallback((key: string, lang: string): void => {
    const state = playStateRef.current;
    if (!state || state.key !== key || typeof window === "undefined" || !window.speechSynthesis) {
      return;
    }
    const chunk = sliceTtsChunkByBytes(state.fullText, state.byteOffset);
    if (!chunk) {
      playStateRef.current = null;
      resumeOffsetRef.current = 0;
      utteranceRef.current = null;
      setSpeakingKey(null);
      return;
    }
    if (!chunk.text.trim()) {
      state.byteOffset = chunk.nextOffset;
      resumeOffsetRef.current = chunk.nextOffset;
      if (state.byteOffset >= fullTextByteLength(state.fullText)) {
        playStateRef.current = null;
        resumeOffsetRef.current = 0;
        utteranceRef.current = null;
        setSpeakingKey(null);
        return;
      }
      speakChunk(key, lang);
      return;
    }
    stoppedByUserRef.current = false;
    const utterance = new SpeechSynthesisUtterance(chunk.text);
    utterance.lang = lang;
    utterance.onboundary = (event) => {
      const active = playStateRef.current;
      if (!active || active.key !== key || event.charIndex === undefined) {
        return;
      }
      const spokenPrefix = chunk.text.slice(0, event.charIndex);
      resumeOffsetRef.current = active.byteOffset + textEncoder.encode(spokenPrefix).length;
    };
    utterance.onend = () => {
      const active = playStateRef.current;
      if (!active || active.key !== key || stoppedByUserRef.current) {
        return;
      }
      active.byteOffset = chunk.nextOffset;
      resumeOffsetRef.current = chunk.nextOffset;
      if (active.byteOffset >= fullTextByteLength(active.fullText)) {
        playStateRef.current = null;
        resumeOffsetRef.current = 0;
        utteranceRef.current = null;
        setSpeakingKey((current) => (current === key ? null : current));
        return;
      }
      window.setTimeout(() => {
        speakChunk(key, lang);
      }, TTS_NEXT_CHUNK_DELAY_MS);
    };
    utterance.onerror = () => {
      if (stoppedByUserRef.current) {
        return;
      }
      playStateRef.current = null;
      resumeOffsetRef.current = 0;
      utteranceRef.current = null;
      setSpeakingKey((current) => (current === key ? null : current));
    };
    utteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  }, []);


  const toggleSpeak = useCallback((key: string, text: string, lang = "zh-CN"): void => {
    const ttsText = sanitizeTextForTts(text);
    if (!ttsText.trim()) {
      return;
    }
    if (speakingKey === key) {
      stop();
      return;
    }
    if (bridgeUrl?.trim()) {
      void (async () => {
        const pilotCapable = await isPilotTtsSynthAvailable(bridgeUrl);
        const defaults = await loadTtsDefaults(bridgeUrl);
        const pilotOk = pilotCapable && await tryPilotTtsSynthesize(bridgeUrl, ttsText, defaults);
        if (pilotOk) {
          setSpeakingKey(key);
          return;
        }
        if (typeof window === "undefined" || !window.speechSynthesis) {
          return;
        }
        window.speechSynthesis.cancel();
        playStateRef.current = {
          key,
          fullText: ttsText,
          byteOffset: 0,
        };
        resumeOffsetRef.current = 0;
        setSpeakingKey(key);
        speakChunk(key, lang);
      })();
      return;
    }
    if (typeof window === "undefined" || !window.speechSynthesis) {
      return;
    }
    window.speechSynthesis.cancel();
    const resumeFromSameMessage = playStateRef.current?.key === key
      ? resumeOffsetRef.current
      : 0;
    playStateRef.current = {
      key,
      fullText: ttsText,
      byteOffset: resumeFromSameMessage,
    };
    resumeOffsetRef.current = resumeFromSameMessage;
    setSpeakingKey(key);
    speakChunk(key, lang);
  }, [bridgeUrl, loadTtsDefaults, speakChunk, speakingKey, stop]);


  return { toggleSpeak, stop, speakingKey };
}
