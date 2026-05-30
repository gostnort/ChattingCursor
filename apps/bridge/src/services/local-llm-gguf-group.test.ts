import assert from "node:assert/strict";
import test from "node:test";
import { groupGgufFilenames, parseGgufFileGroup } from "./local-llm-gguf-group.js";


test("parseGgufFileGroup 合并多分片为同一 groupKey", () => {
  const first = parseGgufFileGroup("BF16/gemma-4-26B-A4B-it-BF16-00001-of-00002.gguf");
  const second = parseGgufFileGroup("BF16/gemma-4-26B-A4B-it-BF16-00002-of-00002.gguf");
  assert.equal(first.groupKey, "BF16/gemma-4-26B-A4B-it-BF16");
  assert.equal(second.groupKey, first.groupKey);
  assert.equal(first.displayLabel, "BF16/gemma-4-26B-A4B-it-BF16");
});


test("groupGgufFilenames Qwen 单文件量化各占一行", () => {
  const groups = groupGgufFilenames([
    "Qwen3.5-9B-Q4_K_M.gguf",
    "Qwen3.5-9B-Q8_0.gguf",
    "Qwen3.5-9B-BF16.gguf",
  ]);
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups.map((item) => item.groupKey).sort(),
    ["Qwen3.5-9B-BF16", "Qwen3.5-9B-Q4_K_M", "Qwen3.5-9B-Q8_0"],
  );
});


test("groupGgufFilenames 将分片合并为一行", () => {
  const groups = groupGgufFilenames([
    "BF16/gemma-4-26B-A4B-it-BF16-00001-of-00002.gguf",
    "BF16/gemma-4-26B-A4B-it-BF16-00002-of-00002.gguf",
    "gemma-4-E4B-it-UD-Q8_K_XL.gguf",
  ]);
  assert.equal(groups.length, 2);
  const bf16 = groups.find((item) => item.groupKey.includes("BF16"));
  assert.ok(bf16);
  assert.equal(bf16?.filenames.length, 2);
  assert.equal(bf16?.displayLabel, "BF16/gemma-4-26B-A4B-it-BF16");
});
