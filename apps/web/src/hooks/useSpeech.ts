import { useCallback, useRef } from "react";


/** 浏览器朗读：新朗读开始前会停止上一条 */
export function useSpeech() {
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);


  const speak = useCallback((text: string, lang = "zh-CN"): void => {
    if (!text.trim() || typeof window === "undefined" || !window.speechSynthesis) {
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  }, []);


  const stop = useCallback((): void => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      return;
    }
    window.speechSynthesis.cancel();
    utteranceRef.current = null;
  }, []);


  return { speak, stop };
}
