import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getBridgeToken,
  getBridgeUrl,
  setBridgePort,
  setBridgeToken,
  setBridgeUrl,
} from "./bridgeSettings";
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
          bridgeUrl={bridgeUrl}
          bridgeToken={bridgeToken}
          onBridgePortChange={handleBridgePortChange}
          onBridgeTokenChange={handleBridgeTokenChange}
          onBridgeUrlChange={handleBridgeUrlChange}
          onLocalSubChange={handleLocalSubChange}
        />
      )}
    </div>
  );
}
