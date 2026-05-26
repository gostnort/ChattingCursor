import { useCallback, useRef, useState } from "react";


/** 浏览器朗读：新朗读开始前会停止上一条 */
export function useSpeech() {
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);


  const stop = useCallback((): void => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      return;
    }
    window.speechSynthesis.cancel();
    utteranceRef.current = null;
    setSpeakingKey(null);
  }, []);


  const toggleSpeak = useCallback((key: string, text: string, lang = "zh-CN"): void => {
    if (!text.trim() || typeof window === "undefined" || !window.speechSynthesis) {
      return;
    }
    if (speakingKey === key) {
      stop();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.onend = () => {
      utteranceRef.current = null;
      setSpeakingKey((current) => (current === key ? null : current));
    };
    utterance.onerror = () => {
      utteranceRef.current = null;
      setSpeakingKey((current) => (current === key ? null : current));
    };
    utteranceRef.current = utterance;
    setSpeakingKey(key);
    window.speechSynthesis.speak(utterance);
  }, [speakingKey, stop]);


  return { toggleSpeak, stop, speakingKey };
}
