import assert from "node:assert/strict";
import test from "node:test";
import { compareAlphaDescNumeric, sortAlphaDescNumeric } from "./alpha-desc-numeric-sort.js";


test("compareAlphaDescNumeric 字母升序、数字降序", () => {
  assert.ok(compareAlphaDescNumeric("alpha", "beta") < 0);
  assert.ok(compareAlphaDescNumeric("gemma-10", "gemma-2") < 0);
  assert.ok(compareAlphaDescNumeric("gemma-2", "gemma-10") > 0);
});


test("sortAlphaDescNumeric 排序", () => {
  const sorted = sortAlphaDescNumeric(["gemma-2", "alpha", "gemma-10"], (item) => item);
  assert.deepEqual(sorted, ["alpha", "gemma-10", "gemma-2"]);
});
