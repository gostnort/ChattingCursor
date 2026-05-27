import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openGoogleSearchInChrome } from "../src/services/chrome-google-search.js";

const query = "test query unique123";
const dir = await mkdtemp(path.join(os.tmpdir(), "websearch-smoke-"));
const statePath = path.join(dir, "websearch-state.json");
process.env.CHATTINGCURSOR_WEBSEARCH_STATE_PATH = statePath;

try {
  const first = await openGoogleSearchInChrome(query);
  console.log("first", {
    ok: first.ok,
    serpStartOffsets: first.meta.serpStartOffsets,
    isRepeat: first.meta.isRepeatSearch,
    linksQueued: first.meta.linksQueued,
    linksCrawled: first.meta.linksCrawled,
  });
  const stateAfterFirst = JSON.parse(await readFile(statePath, "utf8"));
  const second = await openGoogleSearchInChrome(query);
  console.log("second", {
    ok: second.ok,
    serpStartOffsets: second.meta.serpStartOffsets,
    isRepeat: second.meta.isRepeatSearch,
    linksQueued: second.meta.linksQueued,
    linksCrawled: second.meta.linksCrawled,
  });
  const stateAfterSecond = JSON.parse(await readFile(statePath, "utf8"));
  console.log("stateAfterFirst", stateAfterFirst);
  console.log("stateAfterSecond", stateAfterSecond);
} finally {
  process.env.CHATTINGCURSOR_WEBSEARCH_STATE_PATH = "";
  await rm(dir, { recursive: true, force: true });
}
