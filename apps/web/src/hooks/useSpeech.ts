import { useCallback, useRef, useState } from "react";


const TTS_CHUNK_LIMIT = 2000;


/** 朗读前去掉 Markdown 符号，避免 TTS 读出星号等 */
function sanitizeTextForTts(text: string): string {
  return text.replace(/[*_`#/:]/g, "");
}


interface TtsPlayState {
  key: string;
  fullText: string;
  charOffset: number;
}


interface TtsChunk {
  text: string;
  nextOffset: number;
}


/** 在 maxLen 内于最后一个换行处切分，避免截断段落 */
function sliceTtsChunk(fullText: string, startOffset: number, maxLen = TTS_CHUNK_LIMIT): TtsChunk | null {
  const remaining = fullText.slice(startOffset);
  if (!remaining) {
    return null;
  }
  if (remaining.length <= maxLen) {
    return { text: remaining, nextOffset: fullText.length };
  }
  const window = remaining.slice(0, maxLen);
  const lastNewline = window.lastIndexOf("\n");
  const splitAt = lastNewline > 0 ? lastNewline + 1 : maxLen;
  const chunk = remaining.slice(0, splitAt);
  return { text: chunk, nextOffset: startOffset + chunk.length };
}


/** 浏览器朗读：长文本分段顺序播放，停止后可从当前位置续播 */
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
    const chunk = sliceTtsChunk(state.fullText, state.charOffset);
    if (!chunk?.text.trim()) {
      playStateRef.current = null;
      resumeOffsetRef.current = 0;
      utteranceRef.current = null;
      setSpeakingKey(null);
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
      resumeOffsetRef.current = active.charOffset + event.charIndex;
    };
    utterance.onend = () => {
      const active = playStateRef.current;
      if (!active || active.key !== key || stoppedByUserRef.current) {
        return;
      }
      active.charOffset = chunk.nextOffset;
      resumeOffsetRef.current = chunk.nextOffset;
      if (active.charOffset >= active.fullText.length) {
        playStateRef.current = null;
        resumeOffsetRef.current = 0;
        utteranceRef.current = null;
        setSpeakingKey((current) => (current === key ? null : current));
        return;
      }
      speakChunk(key, lang);
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
      charOffset: resumeFromSameMessage,
    };
    resumeOffsetRef.current = resumeFromSameMessage;
    setSpeakingKey(key);
    speakChunk(key, lang);
  }, [speakChunk, speakingKey, stop]);


  return { toggleSpeak, stop, speakingKey };
}
