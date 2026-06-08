import {
  fetchBridgeHealth,
  fetchSchedulerSettings,
  startPilotTts,
} from "./api/bridge";


let sessionAutoStartDone = false;


/** 本地视图挂载后：Bridge 可达且曾启用朗读 API 时，后台启动一次 */
export async function ensurePilotTtsAutoStartedOnce(
  bridgeUrl: string,
  token?: string,
): Promise<void> {
  if (sessionAutoStartDone) {
    return;
  }
  const health = await fetchBridgeHealth(bridgeUrl);
  if (!health) {
    return;
  }
  let settings;
  try {
    const bundle = await fetchSchedulerSettings(bridgeUrl, token);
    settings = bundle.settings;
  } catch {
    return;
  }
  if (!settings.pilotTtsApiEnabled || !settings.pilotTtsEnabled) {
    return;
  }
  sessionAutoStartDone = true;
  try {
    await startPilotTts(bridgeUrl);
  } catch {
    sessionAutoStartDone = false;
  }
}
