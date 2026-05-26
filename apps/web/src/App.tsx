import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getAssistantBubbleColors,
  setAssistantBubbleColors,
} from "./assistantBubbleSettings";
import {
  getBridgeToken,
  getBridgeUrl,
  setBridgePort,
  setBridgeToken,
  setBridgeUrl,
} from "./bridgeSettings";
import { getTextSizePx, setTextSizePx } from "./textSizeSettings";
import { AppHeader } from "./components/AppHeader";
import { ChatView } from "./components/ChatView";
import { LocalView } from "./components/LocalView";
import {
  buildPath,
  normalizeLocation,
  parseRoute,
  type AppMode,
  type AppRoute,
  type LocalSub,
} from "./routing";


function readRoute(): AppRoute {
  return parseRoute(window.location.pathname, window.location.hash);
}


/** 应用根组件：聊天 / 本地 双顶层视图 */
export default function App() {
  const [route, setRoute] = useState<AppRoute>(readRoute);
  const [bridgeUrl, setBridgeUrlState] = useState(() => getBridgeUrl());
  const [bridgeToken, setBridgeTokenState] = useState(() => getBridgeToken());
  const [textSizePx, setTextSizePxState] = useState(() => getTextSizePx());
  const [assistantBubbleColors, setAssistantBubbleColorsState] = useState(() => getAssistantBubbleColors());
  const normalizedBridgeUrl = useMemo(() => bridgeUrl.replace(/\/$/, ""), [bridgeUrl]);


  const navigate = useCallback((next: AppRoute): void => {
    const path = buildPath(next);
    window.history.pushState(null, "", path + window.location.search);
    setRoute(next);
  }, []);


  useEffect(() => {
    const initial = readRoute();
    normalizeLocation(initial);
    setRoute(initial);
    const onPopState = (): void => {
      setRoute(readRoute());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);


  useEffect(() => {
    document.documentElement.style.setProperty("--user-text-size", `${textSizePx}px`);
    document.documentElement.style.setProperty("--composer-text-size", `${textSizePx}px`);
    document.documentElement.style.setProperty("--bubble-text-size", `${textSizePx}px`);
  }, [textSizePx]);


  useEffect(() => {
    document.documentElement.style.setProperty("--assistant-bubble-background", assistantBubbleColors.background);
    document.documentElement.style.setProperty("--assistant-bubble-text", assistantBubbleColors.text);
    document.documentElement.style.setProperty("--assistant-bubble-border", assistantBubbleColors.border);
  }, [assistantBubbleColors]);


  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }
    const updateKeyboardOffset = (): void => {
      const keyboardOffset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty("--keyboard-offset", `${keyboardOffset}px`);
    };
    updateKeyboardOffset();
    viewport.addEventListener("resize", updateKeyboardOffset);
    viewport.addEventListener("scroll", updateKeyboardOffset);
    window.addEventListener("focusin", updateKeyboardOffset);
    window.addEventListener("focusout", updateKeyboardOffset);
    return () => {
      viewport.removeEventListener("resize", updateKeyboardOffset);
      viewport.removeEventListener("scroll", updateKeyboardOffset);
      window.removeEventListener("focusin", updateKeyboardOffset);
      window.removeEventListener("focusout", updateKeyboardOffset);
    };
  }, []);


  const handleBridgePortChange = (port: number): void => {
    setBridgePort(port);
    setBridgeUrlState(getBridgeUrl());
  };


  const handleBridgeUrlChange = (url: string): void => {
    setBridgeUrl(url);
    setBridgeUrlState(getBridgeUrl());
  };


  const handleBridgeTokenChange = (token: string): void => {
    setBridgeToken(token);
    setBridgeTokenState(getBridgeToken());
  };


  const handleTextSizeChange = (size: number): void => {
    setTextSizePxState(setTextSizePx(size));
  };


  const handleAssistantBubbleColorsChange = (colors: {
    background: string;
    text: string;
    border: string;
  }): void => {
    setAssistantBubbleColorsState(setAssistantBubbleColors(colors));
  };


  const handleModeChange = (mode: AppMode): void => {
    navigate({ mode, localSub: route.localSub });
  };


  const handleLocalSubChange = (localSub: LocalSub): void => {
    navigate({ mode: "local", localSub });
  };


  return (
    <div className="app">
      <AppHeader mode={route.mode} onModeChange={handleModeChange} />
      {route.mode === "chat" ? (
        <ChatView bridgeUrl={normalizedBridgeUrl} bridgeToken={bridgeToken} />
      ) : (
        <LocalView
          localSub={route.localSub}
          assistantBubbleColors={assistantBubbleColors}
          bridgeUrl={bridgeUrl}
          bridgeToken={bridgeToken}
          textSizePx={textSizePx}
          onAssistantBubbleColorsChange={handleAssistantBubbleColorsChange}
          onBridgePortChange={handleBridgePortChange}
          onBridgeTokenChange={handleBridgeTokenChange}
          onBridgeUrlChange={handleBridgeUrlChange}
          onTextSizeChange={handleTextSizeChange}
          onLocalSubChange={handleLocalSubChange}
        />
      )}
    </div>
  );
}
