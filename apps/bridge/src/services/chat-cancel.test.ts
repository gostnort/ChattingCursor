import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelActiveRun,
  hasActiveRun,
  registerActiveRun,
  unregisterActiveRun,
} from "./active-run-registry.js";


test("registerActiveRun 与 cancelActiveRun", () => {
  let cancelled = false;
  registerActiveRun("run-1", () => {
    cancelled = true;
  });
  assert.equal(hasActiveRun("run-1"), true);
  assert.equal(cancelActiveRun("run-1"), true);
  assert.equal(cancelled, true);
  assert.equal(hasActiveRun("run-1"), false);
  assert.equal(cancelActiveRun("run-1"), false);
});


test("unregisterActiveRun 移除句柄", () => {
  registerActiveRun("run-2", () => undefined);
  unregisterActiveRun("run-2");
  assert.equal(cancelActiveRun("run-2"), false);
});
