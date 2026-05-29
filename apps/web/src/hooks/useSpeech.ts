import { useCallback, useRef, useState } from "react";


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


/** 浏览器朗读：按字节分段，上一段 onend 后再播下一段 */
export function useSpeech() {
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const playStateRef = useRef<TtsPlayState | null>(null);
  const resumeOffsetRef = useRef(0);
  const stoppedByUserRef = useRef(false);
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);


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
    if (!ttsText.trim() || typeof window === "undefined" || !window.speechSynthesis) {
      return;
    }
    if (speakingKey === key) {
      stop();
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
  }, [speakChunk, speakingKey, stop]);


  return { toggleSpeak, stop, speakingKey };
}
