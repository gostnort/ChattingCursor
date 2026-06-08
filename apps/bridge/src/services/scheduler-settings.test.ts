import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  readSchedulerUserSettings,
  writeSchedulerUserSettings,
} from "./scheduler-settings.js";


test("scheduler-settings 持久化 pilotTtsApiEnabled", async () => {
  const previous = process.env.CHATTINGCURSOR_HOME;
  const home = await mkdtemp(join(tmpdir(), "cc-scheduler-"));
  process.env.CHATTINGCURSOR_HOME = home;
  try {
    const initial = await readSchedulerUserSettings();
    assert.equal(initial.pilotTtsApiEnabled, false);
    await writeSchedulerUserSettings({ pilotTtsApiEnabled: true });
    const after = await readSchedulerUserSettings();
    assert.equal(after.pilotTtsApiEnabled, true);
    await writeSchedulerUserSettings({ pilotTtsApiEnabled: false });
    const off = await readSchedulerUserSettings();
    assert.equal(off.pilotTtsApiEnabled, false);
  } finally {
    if (previous === undefined) {
      delete process.env.CHATTINGCURSOR_HOME;
    } else {
      process.env.CHATTINGCURSOR_HOME = previous;
    }
    await rm(home, { recursive: true, force: true });
  }
});
